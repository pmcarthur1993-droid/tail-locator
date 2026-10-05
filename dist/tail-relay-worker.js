// Cloudflare Worker — CORS relay for the free ADS-B feeds (Cloudflare's free plan is plenty).
// Only needed when the page runs somewhere tail_locator.py is not running (a phone, a hosted copy).
// Cloudflare dashboard → Workers & Pages → Create → Start with Hello World → Edit code → paste → Deploy,
// then put the worker URL (https://<name>.<account>.workers.dev) into the Tail Locator cloud-relay field.
const ALLOW = new Set(['api.adsb.lol', 'globe.adsb.lol', 'adsb.lol', 'api.airplanes.live', 'opendata.adsb.fi', 'api.adsb.one', 'opensky-network.org']);
export default {
  async fetch(req) {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,OPTIONS', 'Access-Control-Allow-Headers': '*' };
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const target = new URL(req.url).searchParams.get('url');
    if (!target) return new Response('usage: ?url=https://api.adsb.lol/v2/reg/EI-DEI', { status: 400, headers: cors });
    let t; try { t = new URL(target); } catch { return new Response('bad url', { status: 400, headers: cors }); }
    if (t.protocol !== 'https:' || !ALLOW.has(t.hostname)) return new Response('host not allowed', { status: 403, headers: cors });
    const up = await fetch(t.toString(), { headers: { 'accept': 'application/json', 'user-agent': 'tail-locator/2.0 (personal, non-commercial)' } });
    const h = new Headers(cors); h.set('content-type', up.headers.get('content-type') || 'application/json'); h.set('cache-control', 'no-store');
    return new Response(up.body, { status: up.status, headers: h });
  }
};
