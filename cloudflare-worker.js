export default {
  async fetch(request, env) {
    if (env.RELAY_KEY && request.headers.get('x-relay-key') !== env.RELAY_KEY) return new Response('forbidden', { status: 403 });
    let target;
    try { target = decodeURIComponent(new URL(request.url).pathname.slice(1)); } catch { return new Response('bad target', { status: 400 }); }
    if (!/^https:\/\/(www\.)?tokyodisneyresort\.jp\//.test(target)) return new Response('bad target', { status: 400 });
    const r = await fetch(target, {
      headers: {
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36',
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'en-US,en;q=0.9,ja;q=0.5',
      },
      cf: { cacheTtl: 300 },
    });
    return new Response(r.body, { status: r.status, headers: { 'content-type': r.headers.get('content-type') || 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
  },
};
