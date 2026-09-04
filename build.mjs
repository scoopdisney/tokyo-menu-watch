// Vercel build: run the sweep, then publish data/ as a static download page.
// Same pattern as wdw-menu-watch. installCommand "echo skip", outputDirectory "public", framework null.
import fs from 'node:fs/promises';
await import('./scan.mjs');
await fs.mkdir('public', { recursive: true });
const files = (await fs.readdir('data').catch(() => [])).filter((f) => f.endsWith('.csv') || f.endsWith('.md') || f.endsWith('.txt'));
for (const f of files) await fs.copyFile('data/' + f, 'public/' + f);
await fs.copyFile('summary.md', 'public/summary.md').catch(() => {});
const summary = await fs.readFile('summary.md', 'utf8').catch(() => '');
const list = ['current.csv', 'tokyo-disneyland.csv', 'tokyo-disneysea.csv', 'price-changes.csv', 'summary.md']
  .filter((f) => files.includes(f) || f === 'summary.md')
  .map((f) => `<li><a href="/${f}" download>${f}</a></li>`).join('');
await fs.writeFile('public/index.html', `<!doctype html><meta charset="utf-8"><title>Tokyo Disney Resort menu watch</title>
<style>body{font:16px/1.5 system-ui;max-width:720px;margin:40px auto;padding:0 16px}pre{white-space:pre-wrap;background:#f5f5f5;padding:12px;border-radius:8px}</style>
<h1>Tokyo Disney Resort menu watch</h1><p>Built ${new Date().toISOString()} UTC. Prices in yen (tax included) with a USD column.</p><ul>${list}</ul><pre>${summary.replace(/[<>&]/g, (c) => ({'<':'<','>':'>','&':'&'}[c]))}</pre>`);
console.log('public/ ready:', files.join(', '));
