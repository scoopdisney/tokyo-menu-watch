// Tokyo Disney Resort menu price watch — SEPARATE from disney-menu-watch (Disneyland) and wdw-menu-watch.
// Source: Oriental Land Co.'s official site, tokyodisneyresort.jp (English pages).
//   1. Venue discovery: /en/tdl/restaurant/list.html and /en/tds/restaurant/list.html
//      -> every link matching /en/<park>/restaurant/detail/<venueId>/
//   2. Per venue: /en/<park>/restaurant/food/<venueId>/  -> every link matching /en/food/<foodId>/
//   3. Per unique food item: /en/food/<foodId>/ (fetched ONCE, shared across venues) -> name, ¥ price,
//      availability window, and the item's own "Available Restaurants" list.
// Prices are in JPY (whole yen). Diff key is venueId + foodId (Disney's own ids), so a renamed item is
// reported as a RENAME instead of vanishing — this closes the rename blind spot the US trackers have.
// Output: data/current.csv, data/tokyo-disneyland.csv, data/tokyo-disneysea.csv, data/price-changes.csv, summary.md

import fs from 'node:fs/promises';

const HOST = 'https://www.tokyodisneyresort.jp';
const PARKS = { tdl: 'Tokyo Disneyland', tds: 'Tokyo DisneySea' };
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';
const CONCURRENCY = Number(process.env.CONCURRENCY || 3);
const DEBUG = process.env.DEBUG_HTML === '1';
const TIMEOUT_MS = 30000;

const TODAY = new Date().toISOString().slice(0, 10);
const NOW = new Date().toISOString().slice(0, 16).replace('T', ' ');
const HEADER = ['Pulled', 'Restaurant', 'Park', 'Area', 'Item', 'PriceJPY', 'PriceText', 'PriceUSD', 'Availability', 'Note', 'FoodId', 'VenueId', 'Source'];
const LOG_HEADER = ['Detected', 'Restaurant', 'Park', 'Item', 'Old Price', 'New Price', 'Change', 'Percent', 'FoodId', 'Source'];

// ---------- tiny HTML helpers (no dependencies) ----------
const decode = (s) => String(s)
  .replace(/&nbsp;/g, ' ').replace(/&/g, '&').replace(/</g, '<').replace(/>/g, '>')
  .replace(/"/g, '"').replace(/&#39;|'/g, "'").replace(/&yen;/g, '¥')
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
const stripTags = (s) => decode(String(s).replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const mainOf = (html) => {
  // Everything after the <h1> and before the footer/site-map block is the page's real content.
  const h1 = html.search(/<h1[\s>]/i);
  let body = h1 >= 0 ? html.slice(h1) : html;
  const cut = body.search(/Menu Items \/ Restaurants|<footer|id=["']footer/i);
  if (cut > 0) body = body.slice(0, cut);
  return body;
};

function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /["\n\r,]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
const toCsv = (rows, header) => [header.join(','), ...rows.map((r) => header.map((h) => csvCell(r[h])).join(','))].join('\n') + '\n';
function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  if (!rows.length) return [];
  const head = rows.shift();
  return rows.filter((r) => r.length > 1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}
async function readIfExists(p) { try { return await fs.readFile(p, 'utf8'); } catch { return null; } }

// ---------- fetch with retry + timeout ----------
async function getHtml(path) {
  let url = path.startsWith('http') ? path : HOST + path;
  if (process.env.FETCH_VIA) url = process.env.FETCH_VIA + encodeURIComponent(url); // optional reverse proxy, see README
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml', 'accept-language': 'en-US,en;q=0.9,ja;q=0.5' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.text();
    } catch (err) {
      if (attempt === 3) throw err;
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
}
async function pool(items, fn) {
  const out = new Array(items.length); let next = 0;
  async function worker() { while (next < items.length) { const i = next++; try { out[i] = { ok: await fn(items[i], i) }; } catch (e) { out[i] = { err: e }; } } }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return out;
}

// ---------- 0. preflight: is the site reachable from this runner at all? ----------
async function abort(reason) {
  await fs.writeFile('summary.md', `## Tokyo menu scan ${NOW} UTC — ABORTED\n\n${reason}\n\nSnapshot left untouched.\n`);
  await fs.writeFile('POST_COMMENT', '1');
  console.log('ABORTED: ' + reason);
  process.exit(0);
}
try {
  const t = await getHtml('/en/');
  if (!/Tokyo Disney/i.test(t)) throw new Error('homepage did not look like tokyodisneyresort.jp (' + t.length + ' bytes)');
} catch (e) {
  await abort(`Could not reach tokyodisneyresort.jp from this runner: ${e.message}. ` +
    'Oriental Land\'s CDN (Akamai) silently drops some datacenter IP ranges. If this repeats on every run, the workflow needs a different egress (see README, "If the runner is blocked").');
}

// ---------- 1. venue discovery ----------
const venues = new Map(); // venueId -> {id, park, parkSlug, name}
for (const parkSlug of Object.keys(PARKS)) {
  let html;
  try { html = await getHtml(`/en/${parkSlug}/restaurant/list.html`); }
  catch (e) { console.log(`venue list ${parkSlug} failed: ${e.message}`); continue; }
  const re = new RegExp(`<a[^>]+href=["'][^"']*/en/${parkSlug}/restaurant/detail/(\\d+)/?["'][^>]*>([\\s\\S]*?)</a>`, 'gi');
  let m;
  while ((m = re.exec(html))) {
    const id = m[1];
    const name = stripTags(m[2]);
    if (!name) continue;
    if (!venues.has(id)) venues.set(id, { id, park: PARKS[parkSlug], parkSlug, name });
  }
}
if (DEBUG) console.log('DEBUG venues:', [...venues.values()].map((v) => `${v.parkSlug}/${v.id} ${v.name}`).join(' | '));
if (venues.size < 20) await abort(`Venue discovery found only ${venues.size} restaurants. The list page markup may have changed — rerun with DEBUG_HTML=1.`);

// ---------- 2. venue menu pages -> food ids ----------
const venueFoods = new Map(); // venueId -> Set(foodId)
const failures = [];
let debugDumped = false;
const vList = [...venues.values()];
const vRes = await pool(vList, async (v) => {
  const html = await getHtml(`/en/${v.parkSlug}/restaurant/food/${v.id}/`);
  if (DEBUG && !debugDumped) { debugDumped = true; console.log(`DEBUG venue menu page ${v.parkSlug}/${v.id} (text):\n` + stripTags(mainOf(html)).slice(0, 3000)); }
  const ids = new Set();
  const re = /href=["'][^"']*\/en\/food\/(\d+)\/?["']/gi;
  let m; while ((m = re.exec(html))) ids.add(m[1]);
  return ids;
});
vRes.forEach((r, i) => {
  const v = vList[i];
  if (r.err) { failures.push(`${v.name} (${v.parkSlug}/${v.id}): ${r.err.message}`); return; }
  venueFoods.set(v.id, r.ok);
});

// ---------- 3. item pages (fetched once each) ----------
const foodIds = [...new Set([...venueFoods.values()].flatMap((s) => [...s]))];
console.log(`${venues.size} venues, ${foodIds.length} unique menu items to fetch`);
let itemDebugDumped = false;

function parseItem(html, foodId) {
  const body = mainOf(html);
  const h1 = (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1];
  let name = stripTags(h1 || '').replace(/COMING SOON/i, '').replace(/お気に入り/g, '').trim();
  if (!name) name = stripTags((html.match(/<title>([^<]*)<\/title>/i) || [])[1] || '').replace(/^\[Official\]\s*/, '').split('|')[0].trim();
  const comingSoon = /COMING SOON/i.test(body);
  // Price block = text before "Available Restaurants"
  const splitAt = body.search(/Available Restaurants/i);
  const priceBlock = stripTags(splitAt > 0 ? body.slice(0, splitAt) : body).replace(/お気に入り/g, ' ').replace(/image of [^¥]*?\d\s/g, ' ');
  const prices = [...priceBlock.matchAll(/¥\s*([\d,]+)/g)].map((x) => Number(x[1].replace(/,/g, ''))).filter((n) => n > 0);
  let priceText = (priceBlock.match(/[^.]*¥\s*[\d,]+[^.]* /) || [''])[0];
  priceText = priceText.replace(name, '').replace(/COMING SOON/i, '').replace(/Available (?:from|through|until)[\s\S]*$/i, '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const availFrom = (priceBlock.match(/Available (?:from|through|until)[^.]*?(?:\d{4})/i) || [''])[0].trim();
  const noteBits = [];
  if (comingSoon) noteBits.push('COMING SOON');
  if (availFrom) noteBits.push(availFrom);
  const descr = priceBlock.replace(/¥\s*[\d,]+/g, '').replace(name, '').replace(/COMING SOON/i, '').replace(/Available (?:from|through|until)[^.]*?\d{4}\.?/i, '').trim();
  if (descr.length > 6) noteBits.push(descr.slice(0, 200));
  // Restaurants listed on the item page, with optional per-venue availability window
  const rest = [];
  if (splitAt > 0) {
    const tail = body.slice(splitAt);
    const re = /<a[^>]+href=["'][^"']*\/en\/(tdl|tds)\/restaurant\/detail\/(\d+)\/?["'][^>]*>([\s\S]*?)<\/a>([\s\S]{0,400}?)(?=<a[^>]+href=["'][^"']*\/restaurant\/detail\/|$)/gi;
    let m;
    while ((m = re.exec(tail))) {
      const txt = stripTags(m[3]);
      const after = stripTags(m[4]);
      const area = ((txt + ' ' + after).match(/Tokyo Disney(?:land|Sea)\s*\/\s*([A-Za-z0-9'’,.&!() -]+?)(?=\s+From |\s+through |\s*$|\s+Tokyo )/) || [])[1] || '';
      const window = ((txt + ' ' + after).match(/From [A-Z][a-z]{2,4}\.? \d{1,2}, \d{4}(?: through [A-Z][a-z]{2,4}\.? \d{1,2}, \d{4})?/) || [''])[0];
      rest.push({ parkSlug: m[1], venueId: m[2], area: area.trim(), window });
    }
  }
  return { foodId, name, prices, priceText, note: noteBits.join(' | '), rest };
}

const items = new Map();
const iRes = await pool(foodIds, async (id) => {
  const html = await getHtml(`/en/food/${id}/`);
  if (DEBUG && !itemDebugDumped) { itemDebugDumped = true; console.log(`DEBUG item page ${id} (raw main html):\n` + mainOf(html).slice(0, 4000)); }
  return parseItem(html, id);
});
iRes.forEach((r, i) => {
  if (r.err) { failures.push(`food/${foodIds[i]}: ${r.err.message}`); return; }
  items.set(foodIds[i], r.ok);
});

// ---------- 4. optional USD column ----------
let jpyPerUsd = null;
try {
  const fx = await (await fetch('https://open.er-api.com/v6/latest/USD', { signal: AbortSignal.timeout(10000) })).json();
  if (fx?.rates?.JPY) jpyPerUsd = fx.rates.JPY;
} catch { /* leave USD blank */ }

// ---------- 5. rows ----------
const current = [];
const counts = new Map();
for (const [venueId, foods] of venueFoods) {
  const v = venues.get(venueId);
  for (const foodId of foods) {
    const it = items.get(foodId);
    if (!it || !it.prices.length) continue; // no price = not a priced row (souvenir add-ons etc. still have ¥ so they stay)
    const onItem = it.rest.find((r) => r.venueId === venueId);
    const price = it.prices[0];
    current.push({
      Pulled: TODAY, Restaurant: v.name, Park: v.park, Area: onItem?.area || '', Item: it.name,
      PriceJPY: String(price), PriceText: it.prices.length > 1 ? it.prices.map((p) => '¥' + p.toLocaleString('en-US')).join(' / ') : it.priceText,
      PriceUSD: jpyPerUsd ? (price / jpyPerUsd).toFixed(2) : '',
      Availability: onItem?.window || '', Note: it.note, FoodId: foodId, VenueId: venueId,
      Source: `${v.parkSlug}/restaurant/food/${venueId} -> food/${foodId}`,
    });
    counts.set(v.name, (counts.get(v.name) || 0) + 1);
  }
}
current.sort((a, b) => a.Park.localeCompare(b.Park) || a.Restaurant.localeCompare(b.Restaurant) || a.Item.localeCompare(b.Item));

const MIN_ROWS = Number(process.env.MIN_ROWS || 300);
if (failures.length > 25 || current.length < MIN_ROWS) {
  await abort(`Only ${current.length} priced rows and ${failures.length} fetch failures (need ≥${MIN_ROWS} rows, ≤25 failures).\n\n${failures.slice(0, 40).map((f) => '- ' + f).join('\n')}`);
}

// ---------- 6. diff against committed snapshot ----------
await fs.mkdir('data', { recursive: true });
const previous = parseCsv((await readIfExists('data/current.csv')) || '');
const keyOf = (r) => `${r.VenueId}\u0000${r.FoodId}`;
const bMap = new Map(previous.map((r) => [keyOf(r), r]));
const cMap = new Map(current.map((r) => [keyOf(r), r]));
const changes = [], added = [], removed = [], renames = [];
for (const [k, b] of bMap) {
  const c = cMap.get(k);
  if (!c) { removed.push(b); continue; }
  const o = Number(b.PriceJPY), n = Number(c.PriceJPY);
  if (o !== n) changes.push({ Detected: NOW, Restaurant: c.Restaurant, Park: c.Park, Item: c.Item, 'Old Price': o, 'New Price': n, Change: n - o, Percent: (((n - o) / o) * 100).toFixed(1) + '%', FoodId: c.FoodId, Source: c.Source });
  if (b.Item !== c.Item) renames.push(`${c.Restaurant} — "${b.Item}" → "${c.Item}" (food/${c.FoodId})`);
}
for (const [k, c] of cMap) if (!bMap.has(k)) added.push(c);
const prevCounts = new Map();
for (const r of previous) prevCounts.set(r.Restaurant, (prevCounts.get(r.Restaurant) || 0) + 1);
const countDeltas = [];
for (const [venue, n] of counts) { const was = prevCounts.get(venue); if (was !== undefined && was !== n) countDeltas.push(`${venue}: ${was} → ${n}`); }

// ---------- 7. write ----------
await fs.writeFile('data/current.csv', toCsv(current, HEADER));
await fs.writeFile('data/tokyo-disneyland.csv', toCsv(current.filter((r) => r.Park === PARKS.tdl), HEADER));
await fs.writeFile('data/tokyo-disneysea.csv', toCsv(current.filter((r) => r.Park === PARKS.tds), HEADER));
if (changes.length) {
  const existing = parseCsv((await readIfExists('data/price-changes.csv')) || '');
  await fs.writeFile('data/price-changes.csv', toCsv([...existing, ...changes], LOG_HEADER));
}

const yen = (n) => '¥' + Number(n).toLocaleString('en-US');
const lastDaily = ((await readIfExists('data/last-daily.txt')) || '').trim();
const isDailySlot = lastDaily !== TODAY;
const lines = [`## Tokyo Disney Resort menu scan ${NOW} UTC`, ''];
lines.push(`${current.length} priced rows across ${venueFoods.size} venues (${items.size} unique items)${failures.length ? `, ${failures.length} fetch failure(s)` : ', 0 failures'}.${jpyPerUsd ? ` USD column at ¥${jpyPerUsd.toFixed(2)}/USD.` : ''}`, '');
if (!previous.length) lines.push('First run — baseline established. Nothing to diff against yet.');
else if (!changes.length && !added.length && !removed.length && !renames.length) lines.push(isDailySlot ? '**Daily check complete — no changes.**' : '**No changes.** No price moves, no items added or removed.');
else {
  if (changes.length) {
    const up = changes.filter((c) => c.Change > 0).length;
    lines.push(`### ${changes.length} price change${changes.length > 1 ? 's' : ''} (${up} up, ${changes.length - up} down)`);
    lines.push(...changes.map((c) => `- **${c.Restaurant}** — ${c.Item}: ${yen(c['Old Price'])} → ${yen(c['New Price'])} (${c.Change > 0 ? '+' : ''}${c.Change}, ${c.Percent})`), '');
  } else lines.push('No price changes.', '');
  if (renames.length) lines.push(`### ${renames.length} rename${renames.length > 1 ? 's' : ''} (same item id, new name)`, ...renames.map((r) => '- ' + r), '');
  if (added.length) { lines.push(`### ${added.length} new item${added.length > 1 ? 's' : ''}`, ...added.slice(0, 40).map((r) => `- **${r.Restaurant}** — ${r.Item} (${yen(r.PriceJPY)})${r.Note ? ' — ' + r.Note.slice(0, 80) : ''}`)); if (added.length > 40) lines.push(`- …and ${added.length - 40} more`); lines.push(''); }
  if (removed.length) { lines.push(`### ${removed.length} item${removed.length > 1 ? 's' : ''} gone`, ...removed.slice(0, 40).map((r) => `- **${r.Restaurant}** — ${r.Item} (was ${yen(r.PriceJPY)})`)); if (removed.length > 40) lines.push(`- …and ${removed.length - 40} more`); lines.push(''); }
}
if (countDeltas.length) lines.push('### Venue count changes', ...countDeltas.map((d) => '- ' + d), '');
if (failures.length) lines.push('### Fetch failures', ...failures.map((f) => '- ' + f), '');
lines.push('---', '_Prices are Oriental Land\'s listed "recommended menu" prices in yen, tax included. Diff key is venue id + item id, so renames are reported rather than lost._');

const hasNews = !previous.length || changes.length || added.length || removed.length || renames.length || failures.length;
const shouldPost = hasNews || isDailySlot;
if (shouldPost) await fs.writeFile('POST_COMMENT', '1');
if (isDailySlot) await fs.writeFile('data/last-daily.txt', TODAY + '\n');
await fs.writeFile('summary.md', lines.join('\n') + '\n');
console.log(lines.join('\n'));
console.log(shouldPost ? (hasNews ? 'NEWS: comment will post' : 'DAILY: comment will post') : 'QUIET: no comment this run');
