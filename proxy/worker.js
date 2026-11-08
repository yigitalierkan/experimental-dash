// Read-only CORS proxy for the OnAir public API (Cloudflare Worker).
// - Only GET /api/v1/* is forwarded (job accept / route overrides are POST → blocked).
// - Only browser origins in ALLOWED_ORIGINS may call it.
// - The visitor's own "oa-apikey" header is passed through; nothing is stored or logged.
const UPSTREAM = 'https://server1.onair.company';

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
    const ok = allowed.length === 0 || allowed.includes('*') || allowed.includes(origin);
    const cors = {
      'Access-Control-Allow-Origin': ok && origin ? origin : 'null',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'oa-apikey, accept, content-type',
      'Access-Control-Expose-Headers': 'Retry-After',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    };
    const reply = (status, body) => new Response(body, { status, headers: { ...cors, 'Content-Type': 'text/plain; charset=utf-8' } });

    if (req.method === 'OPTIONS') return new Response(null, { status: ok ? 204 : 403, headers: cors });
    if (!ok) return reply(403, 'origin not allowed');
    if (req.method !== 'GET') return reply(405, 'read-only proxy');

    const url = new URL(req.url);
    if (url.pathname === '/' || url.pathname === '/health') return reply(200, 'ok');
    if (!url.pathname.startsWith('/api/v1/')) return reply(404, 'not found');
    const key = req.headers.get('oa-apikey');
    if (!key || !/^[0-9a-f-]{36}$/i.test(key)) return reply(401, 'missing or invalid oa-apikey');

    const upstream = await fetch(UPSTREAM + url.pathname + url.search, {
      headers: { 'oa-apikey': key, Accept: 'application/json', 'User-Agent': 'onair-dashboard-proxy' },
    });
    const headers = new Headers(cors);
    headers.set('Content-Type', upstream.headers.get('Content-Type') || 'application/json');
    headers.set('Cache-Control', 'no-store');
    const ra = upstream.headers.get('Retry-After');
    if (ra) headers.set('Retry-After', ra);
    return new Response(upstream.body, { status: upstream.status, headers });
  },
};
