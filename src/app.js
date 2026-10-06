/* Tail Locator — application script (v2, free-first)
   Position-first airport resolution. Sources, in order of preference for the fix:
     free  : adsb.lol / airplanes.live / adsb.fi live APIs, OpenSky live states, adsb.lol per-aircraft traces (history) — all via a relay
     paid  : Flightradar24 API (optional, only if a key is set)
     always: adsbdb.com / hexdb.io identity, callsign route databases, planespotters photo (direct, CORS-enabled)
   Data: AIRPORTS (embedded, OurAirports) rows = [icao, iata, lat, lon, name, city, country, size(L/M/S/W), radiusKm, elevFt]
*/
(() => {
'use strict';

/* ---------- settings & storage ---------- */
const LS = {
  get(k, d) { try { const v = localStorage.getItem('avtl.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('avtl.' + k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem('avtl.' + k); } catch {} }
};
const settings = {
  get fr24Key() { return (LS.get('fr24Key', '') || '').trim(); },
  get sandbox() { return !!LS.get('fr24Sandbox', false); },
  get cloudRelay() { return (LS.get('relay', '') || '').trim(); },
  get lookback() { return Math.min(14, Math.max(1, Number(LS.get('lookback', 7)) || 7)); },
  get units() { return LS.get('units', 'nm'); },
  get autoRun() { return LS.get('autoRun', true) !== false; },
};
const state = { localRelay: '' };
const FR24_BASE = 'https://fr24api.flightradar24.com/api';
const $ = (id) => document.getElementById(id);

/* ---------- airports ---------- */
const APT = (window.AIRPORTS || []).map(r => ({ code: r[0] || '', iata: r[1] || '', lat: r[2], lon: r[3], name: r[4], city: r[5] || '', country: r[6] || '', size: r[7], radius: r[8], elev: r[9] }));
const byIata = new Map(), byIcao = new Map();
for (const a of APT) {
  if (a.iata && (!byIata.has(a.iata) || sizeRank(a) > sizeRank(byIata.get(a.iata)))) byIata.set(a.iata, a);
  if (a.code && !byIcao.has(a.code)) byIcao.set(a.code, a);
}
function sizeRank(a) { return { L: 3, M: 2, S: 1, W: 0 }[a.size] || 0; }
const R_EARTH = 6371.0088;
function hav(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * Math.PI / 180, p2 = lat2 * Math.PI / 180, dp = (lat2 - lat1) * Math.PI / 180, dl = (lon2 - lon1) * Math.PI / 180;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(h)));
}
function bearing(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * Math.PI / 180, p2 = lat2 * Math.PI / 180, dl = (lon2 - lon1) * Math.PI / 180;
  const y = Math.sin(dl) * Math.cos(p2), x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
function nearestAirports(lat, lon, n = 3) {
  const out = [];
  const cosLat = Math.max(0.2, Math.cos(lat * Math.PI / 180));
  for (const a of APT) {
    const dLat = Math.abs(a.lat - lat); if (dLat > 1.5) continue;
    let dLon = Math.abs(a.lon - lon); if (dLon > 180) dLon = 360 - dLon; if (dLon * cosLat > 1.5) continue;
    out.push({ ...a, dist: hav(lat, lon, a.lat, a.lon) });
  }
  out.sort((x, y) => x.dist - y.dist);
  if (out.length > 1 && out[0].dist <= out[0].radius && out[1].dist <= out[1].radius && sizeRank(out[1]) > sizeRank(out[0])) [out[0], out[1]] = [out[1], out[0]];
  return out.slice(0, n);
}
function aptByCodes(c) {
  if (!c) return null;
  const iata = (c.iata || '').toUpperCase(), icao = (c.icao || '').toUpperCase();
  return (iata && byIata.get(iata)) || (icao && byIcao.get(icao)) || (iata || icao ? { code: icao, iata, name: 'Airport not in database', city: '', country: '', lat: NaN, lon: NaN, size: '?', radius: 0, elev: null, unknown: true } : null);
}
function aptAt(lat, lon) { const n = nearestAirports(lat, lon, 1)[0]; return n ? { apt: n, inside: n.dist <= n.radius } : { apt: null, inside: false }; }
const COUNTRIES = window.COUNTRIES || {};
const countryName = (c) => COUNTRIES[c] || c || '';
/* "SNN - Shannon Airport - Ireland" — the website format (ICAO stands in when an airport has no IATA code) */
function airportLine(a) { if (!a) return ''; if (a.unknown) return `${a.iata || a.code} - ${a.iata || a.code} - unknown`; return `${a.iata || a.code || '????'} - ${a.name} - ${countryName(a.country)}`; }

/* ---------- registration normalisation ---------- */
const NOHYPH = ['JA', 'HL', 'UK'];
const PFX3 = ['9XR', 'A40', 'A9C', 'T8A', 'RDPL', 'VPB', 'VPC', 'VQB', 'VQT'];
const PFX2 = ('3A 3B 3C 3D 3X 4K 4L 4O 4R 4X 5A 5B 5H 5N 5R 5T 5U 5V 5W 5X 5Y 6O 6V 6Y 7O 7P 7Q 7T 8P 8Q 8R 9A 9G 9H 9J 9K 9L 9M 9N 9Q 9U 9V 9Y A2 A3 A5 A6 A7 AP C2 C3 C5 C6 C9 CC CN CP CS CU CX D2 D4 D6 DQ E3 E5 E7 EC EI EJ EK EP ER ES ET EW EX EY EZ H4 HA HB HC HH HI HK HP HR HS HZ J2 J3 J5 J6 J7 J8 JU JY LN LV LX LY LZ OB OD OE OH OK OM OO OY P2 P4 PH PJ PK PP PR PS PT PU PZ RA RP S2 S5 S7 S9 SE SP ST SU SX T2 T3 T7 T9 TC TF TG TI TJ TL TN TR TS TT TU TY TZ UN UP UR V2 V3 V4 V5 V6 V7 V8 VH VN VP VQ VT XA XB XC XT XU XY YA YI YJ YK YL YN YR YS YU YV Z3 ZA ZK ZL ZM ZP ZS ZT ZU').split(' ');
const PFX1 = ['B', 'C', 'D', 'F', 'G', 'I', 'M', 'P', 'Z', '2'];
function canonicalReg(raw) {
  let s = String(raw || '').toUpperCase().replace(/[^A-Z0-9-]/g, '');
  if (!s) return '';
  if (s.includes('-')) return s.replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (/^N\d/.test(s)) return s;
  for (const p of NOHYPH) if (s.startsWith(p)) return s;
  for (const p of PFX3) if (s.startsWith(p) && s.length > p.length) {
    if (p.length === 3 && p[0] === 'V') return s.slice(0, 2) + '-' + s.slice(2);
    return p + '-' + s.slice(p.length);
  }
  for (const p of PFX2) if (s.startsWith(p) && s.length > 2) return p + '-' + s.slice(2);
  for (const p of PFX1) if (s.startsWith(p) && s.length > 1) return p + '-' + s.slice(1);
  return s;
}
function regVariants(canon) { const bare = canon.replace(/-/g, ''); return canon === bare ? [canon] : [canon, bare]; }
const regKey = (r) => String(r || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
function parseInput(text) {
  const parts = String(text || '').split(/[\s,;]+/).map(canonicalReg).filter(Boolean);
  const seen = new Set(), out = [];
  for (const p of parts) { const k = regKey(p); if (k.length >= 3 && !seen.has(k)) { seen.add(k); out.push(p); } }
  return out.slice(0, 15);
}

/* ---------- fetch helpers ---------- */
class SrcError extends Error { constructor(code, msg, status) { super(msg || code); this.code = code; this.status = status; } }
async function fetchT(url, opts = {}, ms = 20000) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  catch (e) { throw new SrcError('network', e.name === 'AbortError' ? 'timed out' : 'network/CORS error'); }
  finally { clearTimeout(t); }
}
async function getJSON(url, opts, ms) {
  const r = await fetchT(url, opts, ms);
  if (!r.ok) { let d = ''; try { d = (await r.json()).error || ''; } catch {} throw new SrcError('http', `HTTP ${r.status}${d ? ' ' + d : ''}`, r.status); }
  return r.json();
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const isoZ = (d) => new Date(d).toISOString().replace(/\.\d{3}Z$/, 'Z');

/* ---------- relay (local launcher first, cloud worker second) ---------- */
function haveRelay() { return !!(state.localRelay || settings.cloudRelay); }
function relayName() { return state.localRelay ? 'local relay' : settings.cloudRelay ? 'cloud relay' : ''; }
function relayUrl(target) {
  if (state.localRelay) return state.localRelay + '?url=' + encodeURIComponent(target);
  const relay = settings.cloudRelay; if (!relay) throw new SrcError('no_relay', 'no relay available');
  if (relay.includes('{url}')) return relay.replace('{url}', encodeURIComponent(target));
  return relay + (relay.includes('?') ? '&' : '?') + 'url=' + encodeURIComponent(target);
}
async function detectLocalRelay() {
  if (!/^https?:$/.test(location.protocol)) return false;
  try { const j = await getJSON(location.origin + '/ping', {}, 3000); if (j && j.relay === 'local') { state.localRelay = location.origin + '/relay'; state.serverLocate = location.origin + '/locate'; state.flightaware = !!j.flightaware; state.fr24Server = !!j.fr24; state.fr24ServerKey = !!j.fr24_server_key; return true; } } catch {}
  return false;
}

/* ---------- free live sources: readsb-style aggregators + OpenSky ---------- */
const AGG = [
  { name: 'adsb.lol', reg: r => `https://api.adsb.lol/v2/reg/${r}`, hex: h => `https://api.adsb.lol/v2/hex/${h}` },
  { name: 'airplanes.live', reg: r => `https://api.airplanes.live/v2/reg/${r}`, hex: h => `https://api.airplanes.live/v2/hex/${h}` },
  { name: 'adsb.fi', reg: r => `https://opendata.adsb.fi/api/v2/registration/${r}`, hex: h => `https://opendata.adsb.fi/api/v2/hex/${h}` },
];
function mapReadsb(ac, nowMs, src) {
  const hasPos = typeof ac.lat === 'number' && typeof ac.lon === 'number';
  const seenPos = typeof ac.seen_pos === 'number' ? ac.seen_pos : (typeof ac.seen === 'number' ? ac.seen : 0);
  return {
    src, reg: (ac.r || '').trim(), hex: (ac.hex || '').toUpperCase(), type: ac.t || '', desc: ac.desc || '',
    t: nowMs - seenPos * 1000, lat: hasPos ? ac.lat : NaN, lon: hasPos ? ac.lon : NaN,
    alt: ac.alt_baro === 'ground' ? 'ground' : (typeof ac.alt_baro === 'number' ? ac.alt_baro : (typeof ac.alt_geom === 'number' ? ac.alt_geom : null)),
    gs: typeof ac.gs === 'number' ? ac.gs : null, vs: typeof ac.baro_rate === 'number' ? ac.baro_rate : (typeof ac.geom_rate === 'number' ? ac.geom_rate : null),
    track: typeof ac.track === 'number' ? ac.track : null, squawk: ac.squawk || '', source: (ac.type || '').toUpperCase().replace('_', ' '),
    callsign: (ac.flight || '').trim(), flight: '', operator: ac.ownOp || '', orig: { iata: '', icao: '' }, dest: { iata: '', icao: '' }, eta: null
  };
}
async function aggregatorLookup(items, log) {
  // Every aggregator is queried (not just until the first hit) so independent sources can corroborate each other.
  const found = new Map(); // regKey -> [fix, ...]
  const add = (k, f) => { if (!found.has(k)) found.set(k, []); if (!found.get(k).some(x => x.src === f.src)) found.get(k).push(f); };
  for (const agg of AGG) {
    try {
      const regs = [...new Set(items.flatMap(it => it.variants))];
      const j = await getJSON(relayUrl(agg.reg(regs.join(','))), {}, 15000);
      const nowMs = typeof j.now === 'number' ? j.now : Date.now();
      let hits = 0;
      for (const ac of (j.ac || [])) {
        const f = mapReadsb(ac, nowMs, agg.name); const k = regKey(f.reg);
        const it = items.find(x => regKey(x.reg) === k) || items.find(x => x.hex && f.hex && x.hex.toUpperCase() === f.hex);
        if (it) { f.reg = f.reg || it.reg; add(regKey(it.reg), f); hits++; }
      }
      const hexes = items.filter(it => it.hex && !(found.get(regKey(it.reg)) || []).some(f => f.src === agg.name)).map(it => it.hex.toLowerCase());
      if (hexes.length) {
        await sleep(1000); // 1 request/second per aggregator
        const j2 = await getJSON(relayUrl(agg.hex(hexes.join(','))), {}, 15000);
        const now2 = typeof j2.now === 'number' ? j2.now : Date.now();
        for (const ac of (j2.ac || [])) { const f = mapReadsb(ac, now2, agg.name); const it = items.find(x => x.hex && x.hex.toUpperCase() === f.hex); if (it) { f.reg = f.reg || it.reg; add(regKey(it.reg), f); hits++; } }
      }
      log(`${agg.name}: ${hits}/${items.length} currently transmitting`);
    } catch (e) { log(`${agg.name}: ${e.message}`); }
  }
  return found;
}
async function openskyLookup(items, log) {
  const withHex = items.filter(it => it.hex);
  const found = new Map();
  if (!withHex.length) return found;
  try {
    const q = withHex.map(it => 'icao24=' + it.hex.toLowerCase()).join('&');
    const j = await getJSON(relayUrl(`https://opensky-network.org/api/states/all?${q}`), {}, 20000);
    const rows = Array.isArray(j.states) ? j.states : [];
    for (const s of rows) {
      const hex = String(s[0] || '').toUpperCase(); const it = withHex.find(x => x.hex.toUpperCase() === hex); if (!it) continue;
      const lat = s[6], lon = s[5]; if (typeof lat !== 'number' || typeof lon !== 'number') continue;
      found.set(regKey(it.reg), {
        src: 'OpenSky', reg: it.reg, hex, type: '', t: (s[3] || s[4] || j.time) * 1000, lat, lon,
        alt: s[8] ? 'ground' : (typeof s[7] === 'number' ? Math.round(s[7] * 3.28084) : null),
        gs: typeof s[9] === 'number' ? Math.round(s[9] * 1.94384) : null, vs: typeof s[11] === 'number' ? Math.round(s[11] * 196.85) : null,
        track: typeof s[10] === 'number' ? s[10] : null, squawk: s[14] || '', source: ['ADS-B', 'ASTERIX', 'MLAT', 'FLARM'][s[16]] || 'ADS-B',
        callsign: String(s[1] || '').trim(), flight: '', operator: '', orig: { iata: '', icao: '' }, dest: { iata: '', icao: '' }, eta: null
      });
    }
    log(`OpenSky: ${found.size}/${withHex.length} currently transmitting`);
  } catch (e) { log(`OpenSky: ${e.message}${e.status === 429 ? ' (anonymous daily limit reached)' : ''}`); }
  return found;
}

/* ---------- free history: adsb.lol per-aircraft traces ---------- */
function utcDayPath(d) { const p = (n) => String(n).padStart(2, '0'); return `${d.getUTCFullYear()}/${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())}`; }
function parseTrace(j) {
  const base = Number(j.timestamp) || 0; const pts = [];
  for (const p of (j.trace || [])) {
    if (!Array.isArray(p) || typeof p[1] !== 'number' || typeof p[2] !== 'number') continue;
    const ac = p[8] && typeof p[8] === 'object' ? p[8] : null;
    pts.push({ t: (base + p[0]) * 1000, lat: p[1], lon: p[2], alt: p[3] === 'ground' ? 'ground' : (typeof p[3] === 'number' ? p[3] : null), gs: typeof p[4] === 'number' ? p[4] : null, track: typeof p[5] === 'number' ? p[5] : null, flags: p[6] || 0, vs: typeof p[7] === 'number' ? p[7] : null, callsign: ac && ac.flight ? String(ac.flight).trim() : '', squawk: ac && ac.squawk ? ac.squawk : '', source: typeof p[9] === 'string' ? p[9].toUpperCase().replace('_', ' ') : '' });
  }
  return { hex: String(j.icao || '').toUpperCase(), reg: j.r || '', type: j.t || '', desc: j.desc || '', pts };
}
async function traceLookup(it, log) {
  if (!it.hex) { log('adsb.lol traces: no Mode S hex known for this registration, cannot fetch history'); return null; }
  const hex = it.hex.toLowerCase(), suffix = hex.slice(-2);
  const got = []; let fetched = 0;
  const grab = async (url, label) => {
    fetched++;
    try { const j = await getJSON(relayUrl(url), {}, 25000); const tr = parseTrace(j); if (tr.pts.length) { got.push({ label, tr }); return true; } return false; }
    catch (e) { if (e.status !== 404) log(`adsb.lol trace ${label}: ${e.message}`); return false; }
  };
  const today = new Date();
  let found = await grab(`https://globe.adsb.lol/data/traces/${suffix}/trace_full_${hex}.json`, 'recent');
  let day = 1;
  while (!found && day <= settings.lookback) { const d = new Date(today.getTime() - day * 86400000); found = await grab(`https://globe.adsb.lol/globe_history/${utcDayPath(d)}/traces/${suffix}/trace_full_${hex}.json`, utcDayPath(d)); day++; }
  if (!found) { log(`adsb.lol traces: nothing in the last ${settings.lookback} days (${fetched} files checked) — aircraft not seen by the network`); return null; }
  const ctxDay = new Date(today.getTime() - day * 86400000);
  await grab(`https://globe.adsb.lol/globe_history/${utcDayPath(ctxDay)}/traces/${suffix}/trace_full_${hex}.json`, utcDayPath(ctxDay));
  const pts = got.flatMap(g => g.tr.pts).sort((a, b) => a.t - b.t).filter((p, i, a) => i === 0 || p.t !== a[i - 1].t);
  const meta = got[0].tr;
  log(`adsb.lol traces: ${pts.length} positions from ${got.map(g => g.label).join(' + ')}`);
  return { pts, meta, days: got.map(g => g.label) };
}
function isGroundPt(p) { return p.alt === 'ground' || (typeof p.alt === 'number' && p.gs != null && p.gs < 40 && p.alt < 4000); }
function legsFromPoints(pts) {
  const legs = []; let cur = null, lastGround = null, callsign = '';
  const close = (p, how) => { cur.end = p.t; cur.arr = how === 'landed' ? { lat: p.lat, lon: p.lon, t: p.t } : null; cur.how = how; legs.push(cur); cur = null; };
  for (const p of pts) {
    if (p.callsign) callsign = p.callsign;
    const ground = isGroundPt(p);
    if (cur && (p.flags & 2) && cur.n > 2 && !ground) close(cur.last, 'lost');
    if (!ground && !cur) { const lgOk = lastGround && (p.t - lastGround.t) <= 45 * 60000 && hav(p.lat, p.lon, lastGround.lat, lastGround.lon) <= 60; cur = { start: p.t, dep: lgOk ? { lat: lastGround.lat, lon: lastGround.lon, t: lastGround.t } : { lat: p.lat, lon: p.lon, t: p.t, inferred: true, alt: p.alt }, callsign, maxAlt: 0, n: 0, squawk: '' }; }
    if (cur) { cur.n++; if (typeof p.alt === 'number') cur.maxAlt = Math.max(cur.maxAlt, p.alt); if (p.callsign) cur.callsign = p.callsign; if (p.squawk) cur.squawk = p.squawk; cur.last = p; }
    if (ground && cur) close(p, 'landed');
    if (ground) lastGround = p;
  }
  if (cur) close(cur.last, 'inprogress');
  return legs.filter(l => (l.end - l.start) > 180000 || l.maxAlt > 1500).map(l => {
    const d = aptAt(l.dep.lat, l.dep.lon), a = l.arr ? aptAt(l.arr.lat, l.arr.lon) : { apt: null, inside: false };
    const depOk = l.dep.inferred ? (d.apt && d.apt.dist <= 15 && (typeof l.dep.alt !== 'number' || l.dep.alt - (d.apt.elev || 0) <= 5000)) : (d.apt && d.apt.dist <= d.apt.radius + 3);
    return { ...l, depApt: depOk ? d.apt : null, depInside: !!depOk, arrApt: a.apt, arrInside: a.inside };
  });
}
function lastPointAsFix(tr) {
  const p = tr.pts[tr.pts.length - 1]; if (!p) return null;
  let callsign = ''; for (let i = tr.pts.length - 1; i >= 0 && !callsign; i--) callsign = tr.pts[i].callsign;
  return { src: 'adsb.lol trace', reg: tr.meta.reg, hex: tr.meta.hex, type: tr.meta.type, desc: tr.meta.desc, t: p.t, lat: p.lat, lon: p.lon, alt: p.alt, gs: p.gs, vs: p.vs, track: p.track, squawk: p.squawk, source: p.source, callsign, flight: '', operator: '', orig: { iata: '', icao: '' }, dest: { iata: '', icao: '' }, eta: null, fromTrace: true };
}

/* ---------- FR24 (optional, paid) ---------- */
let fr24Credits = 0;
async function fr24(path, params) {
  const key = settings.fr24Key; if (!key) throw new SrcError('no_key', 'FR24 key not set');
  const url = new URL(FR24_BASE + path);
  for (const [k, v] of Object.entries(params || {})) if (v != null && v !== '') url.searchParams.set(k, v);
  const r = await fetchT(url, { headers: { 'Accept': 'application/json', 'Accept-Version': 'v1', 'Authorization': 'Bearer ' + key } });
  if (r.status === 404) return { data: [] };
  if (r.status === 401) throw new SrcError('fr24_auth', 'FR24 rejected the key (401)');
  if (r.status === 402) throw new SrcError('fr24_credits', 'FR24: no credits left (402)');
  if (r.status === 429) throw new SrcError('fr24_rate', 'FR24 rate limit (429) — wait a minute');
  if (!r.ok) { let d = ''; try { d = (await r.json()).message || ''; } catch {} throw new SrcError('fr24_http', `FR24 HTTP ${r.status} ${d}`.trim()); }
  return r.json();
}
async function fr24Live(regs) {
  const j = await fr24('/live/flight-positions/full', { registrations: regs.join(',') });
  const rows = Array.isArray(j.data) ? j.data : [];
  fr24Credits += rows.length * 8;
  return rows.map(d => ({
    src: 'FR24', fr24_id: d.fr24_id, reg: d.reg, hex: d.hex, type: d.type,
    t: d.timestamp ? Date.parse(d.timestamp) : Date.now(),
    lat: d.lat, lon: d.lon, alt: typeof d.alt === 'number' ? d.alt : null, gs: d.gspeed, vs: d.vspeed, track: d.track, squawk: d.squawk, source: d.source,
    callsign: (d.callsign || '').trim(), flight: (d.flight || '').trim(), operator: d.operating_as || d.painted_as || '',
    orig: { iata: d.orig_iata || '', icao: d.orig_icao || '' }, dest: { iata: d.dest_iata || '', icao: d.dest_icao || '' },
    eta: d.eta ? Date.parse(d.eta) : null
  }));
}
async function fr24Summary(regs, days) {
  const to = Date.now(), from = to - Math.min(14, days) * 86400000;
  const j = await fr24('/flight-summary/full', { registrations: regs.join(','), flight_datetime_from: isoZ(from), flight_datetime_to: isoZ(to), sort: 'desc' });
  const rows = Array.isArray(j.data) ? j.data : [];
  for (const d of rows) fr24Credits += d.flight_ended === false ? 2 : 3;
  return rows.map(d => ({
    fr24_id: d.fr24_id, reg: d.reg, hex: d.hex, type: d.type, flight: (d.flight || '').trim(), callsign: (d.callsign || '').trim(), operator: d.operating_as || d.painted_as || '',
    orig: { iata: d.orig_iata || '', icao: d.orig_icao || '' }, dest: { iata: d.dest_iata || '', icao: d.dest_icao || '' },
    destActual: { iata: d.dest_iata_actual || '', icao: d.dest_icao_actual || '' },
    takeoff: d.datetime_takeoff ? Date.parse(d.datetime_takeoff) : null, landed: d.datetime_landed ? Date.parse(d.datetime_landed) : null,
    firstSeen: d.first_seen ? Date.parse(d.first_seen) : null, lastSeen: d.last_seen ? Date.parse(d.last_seen) : null,
    ended: d.flight_ended, rwyLanded: d.runway_landed || '', flightTime: d.flight_time
  })).sort((a, b) => (b.firstSeen || 0) - (a.firstSeen || 0));
}

/* ---------- identity, route, photo (direct, keyless) ---------- */
const CACHE = { get(k) { const v = LS.get('cache.' + k); return v && v.exp > Date.now() ? v.val : null; }, set(k, val, ttlMs) { LS.set('cache.' + k, { val, exp: Date.now() + ttlMs }); } };
async function identity(canon) {
  const ck = 'id.' + regKey(canon); const c = CACHE.get(ck); if (c) return c;
  let out = null;
  for (const v of regVariants(canon)) {
    try {
      const j = await getJSON(`https://api.adsbdb.com/v0/aircraft/${encodeURIComponent(v)}`, {}, 12000);
      const a = j && j.response && j.response.aircraft;
      if (a) { out = { hex: (a.mode_s || '').toUpperCase(), type: a.icao_type || '', typeName: [a.manufacturer, a.type].filter(Boolean).join(' '), operator: a.registered_owner || '', opFlag: a.registered_owner_operator_flag_code || '', country: a.registered_owner_country_name || '', photo: a.url_photo_thumbnail || '', photoLink: a.url_photo || '', reg: a.registration || canon, src: 'adsbdb' }; break; }
    } catch {}
  }
  if (!out) {
    try {
      const r = await fetchT(`https://hexdb.io/reg-hex?reg=${encodeURIComponent(canon)}`, {}, 10000);
      const hex = (await r.text()).trim().toUpperCase();
      if (/^[0-9A-F]{6}$/.test(hex)) {
        const j = await getJSON(`https://hexdb.io/api/v1/aircraft/${hex}`, {}, 10000);
        out = { hex, type: j.ICAOTypeCode || '', typeName: [j.Manufacturer, j.Type].filter(Boolean).join(' '), operator: j.RegisteredOwners || '', opFlag: j.OperatorFlagCode || '', country: '', photo: '', photoLink: '', reg: j.Registration || canon, src: 'hexdb' };
      }
    } catch {}
  }
  if (out) CACHE.set(ck, out, 30 * 86400000);
  return out;
}
async function photoFor(canon) {
  const ck = 'ph.' + regKey(canon); const c = CACHE.get(ck); if (c) return c;
  try {
    const j = await getJSON(`https://api.planespotters.net/pub/photos/reg/${encodeURIComponent(canon)}`, {}, 10000);
    const p = j && j.photos && j.photos[0];
    if (p) { const out = { src: (p.thumbnail_large || p.thumbnail || {}).src || '', link: p.link || '', credit: `© ${p.photographer || 'photographer'} / planespotters.net` }; CACHE.set(ck, out, 7 * 86400000); return out; }
  } catch {}
  return null;
}
function normCallsign(cs) { const m = /^([A-Z]{3})0*(\d+[A-Z]*)$/.exec(cs); return m ? m[1] + m[2] : cs; }
async function routeFor(callsign) {
  const cs = normCallsign(String(callsign || '').toUpperCase().trim()); if (!/^[A-Z]{3}\d/.test(cs)) return null;
  const ck = 'rt.' + cs; const c = CACHE.get(ck); if (c) return c;
  let out = null;
  try { const j = await getJSON(`https://api.adsbdb.com/v0/callsign/${cs}`, {}, 10000); const fr = j && j.response && j.response.flightroute;
    if (fr && fr.origin && fr.destination) out = { src: 'adsbdb', orig: { iata: fr.origin.iata_code || '', icao: fr.origin.icao_code || '' }, dest: { iata: fr.destination.iata_code || '', icao: fr.destination.icao_code || '' }, airline: fr.airline ? fr.airline.name : '', iataFlight: fr.callsign_iata || '' }; } catch {}
  if (!out) try { const j = await getJSON(`https://hexdb.io/api/v1/route/icao/${cs}`, {}, 10000); const m = /^([A-Z0-9]{3,4})-([A-Z0-9]{3,4})/.exec(j.route || '');
    if (m) out = { src: 'hexdb', orig: { iata: '', icao: m[1] }, dest: { iata: '', icao: m[2] }, airline: '', iataFlight: '' }; } catch {}
  if (!out) try { const j = await getJSON(`https://vrs-standing-data.adsb.lol/routes/${cs.slice(0, 2)}/${cs}.json`, {}, 10000); const m = /^([A-Z0-9]{3,4})-([A-Z0-9]{3,4})/.exec(j.airport_codes || ''); const mi = /^([A-Z0-9]{3})-([A-Z0-9]{3})/.exec(j._airport_codes_iata || '');
    if (m) out = { src: 'VRS', orig: { iata: mi ? mi[1] : '', icao: m[1] }, dest: { iata: mi ? mi[2] : '', icao: m[2] }, airline: '', iataFlight: '' }; } catch {}
  if (out) { for (const k of ['orig', 'dest']) { const a = aptByCodes(out[k]); if (a && !a.unknown) { out[k].iata = out[k].iata || a.iata; out[k].icao = out[k].icao || a.code; } } CACHE.set(ck, out, 6 * 3600000); }
  return out;
}

/* ---------- the verdict ---------- */
const FRESH_S = 15 * 60;
function codeOf(c) { return c ? (c.iata || c.icao || '') : ''; }
function sameApt(a, b) { if (!a || !b) return false; const A = aptByCodes(a), B = aptByCodes(b); if (A && B && !A.unknown && !B.unknown) return A === B; return codeOf(a) && codeOf(a) === codeOf(b); }
function aptCodes(a) { return a ? { iata: a.iata, icao: a.code } : null; }
function decide(res) {
  const now = Date.now();
  const v = { cls: 'none', label: 'No position data', airport: null, dist: null, conf: 'low', flags: [], evidence: [], via: '', nearest: null, mode: 'none' };
  const live = res.live, leg = res.legs && res.legs[0], mv = res.movements && res.movements.length ? res.movements[res.movements.length - 1] : null;
  if (live && isFinite(live.lat) && isFinite(live.lon)) {
    const age = Math.max(0, (now - live.t) / 1000);
    const near = nearestAirports(live.lat, live.lon, 3); const n0 = near[0] || null; v.nearest = near;
    const elev = n0 && n0.elev != null ? n0.elev : 0;
    let onGround = live.alt === 'ground' || (typeof live.alt === 'number' && (live.gs == null || live.gs <= 60) && (live.alt - elev) <= 1500 && (live.vs == null || Math.abs(live.vs) < 300));
    const fresh = age <= FRESH_S;
    let landingNote = null;
    if (!onGround && !fresh && n0) { landingNote = landingInferred(live, n0, age); if (landingNote) onGround = true; }
    v.landingNote = landingNote;
    const fixLine = `${live.src} fix ${fmtAge(age)} old at ${live.lat.toFixed(4)}, ${live.lon.toFixed(4)}${live.alt === 'ground' ? ', on-ground flag set' : (typeof live.alt === 'number' ? `, ${fmtInt(live.alt)} ft` : '')}${live.gs != null ? `, ${fmtInt(live.gs)} kt` : ''}${live.source ? ` (${live.source})` : ''}.`;
    v.via = live.src;
    if (onGround) {
      v.mode = 'ground';
      if (n0 && (n0.dist <= n0.radius || landingNote)) {
        v.airport = n0; v.dist = n0.dist;
        if (landingNote) v.evidence.push('Landing inferred: ' + landingNote);
        if (fresh) { v.cls = 'ground'; v.label = 'On ground'; v.conf = 'high'; }
        else if (age < 3 * 86400) { v.cls = 'ground'; v.label = `On ground · since ${fmtTime(live.t)}`; v.conf = 'high'; }
        else { v.cls = 'stale'; v.label = `Last seen on ground · ${fmtTime(live.t)}`; v.conf = 'med'; }
        v.evidence.push(fixLine, `${fmtDist(n0.dist)} from the ${n0.code || n0.iata} reference point, inside its ${fmtDist(n0.radius)} boundary.`);
        if (!fresh) v.evidence.push('No transmission since then from any source checked. An airliner cannot leave a surveilled airport unseen, so it is still there unless towed or ferried with the transponder off.');
      } else {
        v.airport = n0; v.dist = n0 ? n0.dist : null; v.cls = 'stale'; v.conf = 'low';
        v.label = fresh ? 'On ground · off-airport' : `Last seen on ground · ${fmtTime(live.t)}`;
        v.evidence.push(fixLine); if (n0) v.flags.push({ cls: 'warn', text: `${fmtDist(n0.dist)} outside the ${n0.code || n0.iata} boundary — check the map` });
      }
      if (leg) {
        const landedAt = (leg.destActual && codeOf(leg.destActual)) ? leg.destActual : leg.dest;
        if (leg.ended !== false && landedAt && v.airport && !v.airport.unknown) {
          if (sameApt(landedAt, aptCodes(v.airport))) v.evidence.push(`Matches FR24's last recorded landing (${leg.flight || leg.callsign || 'flight'} from ${codeOf(leg.orig) || '?'}, ${leg.landed ? fmtTime(leg.landed) : 'time n/a'}).`);
          else v.flags.push({ cls: 'warn', text: `FR24's last recorded landing was at ${codeOf(landedAt)}, position says ${v.airport.iata || v.airport.code}` });
        }
        if (leg.destActual && codeOf(leg.destActual) && codeOf(leg.dest) && !sameApt(leg.destActual, leg.dest)) v.flags.push({ cls: 'bad', text: `Last flight DIVERTED — filed ${codeOf(leg.dest)}, landed ${codeOf(leg.destActual)}` });
      } else if (mv && mv.how === 'landed' && mv.arrApt) {
        if (v.airport && !v.airport.unknown && mv.arrApt.code === v.airport.code) v.evidence.push(`Last movement in the traces: ${mv.callsign || 'flight'} ${mv.depApt ? (mv.depApt.iata || mv.depApt.code) : '?'} → ${mv.arrApt.iata || mv.arrApt.code}, landed ${fmtTime(mv.end)}.`);
        if (mv.route && mv.route.dest && codeOf(mv.route.dest) && !sameApt(mv.route.dest, aptCodes(mv.arrApt))) v.evidence.push(`Route database lists callsign ${mv.callsign} as ${codeOf(mv.route.orig) || '?'} → ${codeOf(mv.route.dest)}; the aircraft landed at ${mv.arrApt.iata || mv.arrApt.code}. Usual routes are not filed plans, so this is noted, not treated as a diversion — only FR24's flight record can confirm one.`);
      }
      if (live.dest && codeOf(live.dest) && v.airport && !sameApt(live.dest, aptCodes(v.airport))) {
        if (live.orig && sameApt(live.orig, aptCodes(v.airport))) v.flags.push({ cls: 'air', text: `Filed ${codeOf(live.orig)} → ${codeOf(live.dest)}, not yet departed` });
        else v.flags.push({ cls: 'warn', text: `Filed destination ${codeOf(live.dest)} differs from the current airport` });
      }
    } else {
      v.mode = 'air';
      v.cls = fresh ? 'air' : 'stale'; v.label = fresh ? 'In flight' : `Last seen in flight · ${fmtTime(live.t)}`;
      const dest = (live.dest && codeOf(live.dest)) ? live.dest : (res.route && res.route.dest && codeOf(res.route.dest)) ? res.route.dest : (leg && leg.ended === false ? ((leg.destActual && codeOf(leg.destActual)) ? leg.destActual : leg.dest) : null);
      const destApt = aptByCodes(dest);
      v.evidence.push(fixLine);
      if (!fresh) v.evidence.push('The track ended while airborne — out of receiver coverage (oceanic, remote) or the landing was not received. Where it went next is unknown.');
      if (destApt && !destApt.unknown) {
        v.airport = destApt; v.destIsFiled = true; const d = hav(live.lat, live.lon, destApt.lat, destApt.lon); v.dist = d;
        v.conf = fresh ? 'high' : 'low';
        const filed = !!(live.dest && codeOf(live.dest));
        const how = filed ? 'from FR24 flight data' : res.route ? `from the ${res.route.src} route database for callsign ${live.callsign} — typical route, not a filed plan` : '';
        v.evidence.push(`${filed ? 'Filed' : 'Expected'} destination ${destApt.iata || destApt.code} (${destApt.name}), ${fmtDist(d)} away${live.eta ? `, ETA ${fmtTime(live.eta)}` : ''}${how ? ' — ' + how : ''}.`);
        if (fresh && typeof live.alt === 'number' && live.alt < 12000 && (live.vs == null || live.vs < -200) && n0 && n0.dist <= 45 && n0.code !== destApt.code && sizeRank(n0) >= 2 && (live.track == null || angDiff(live.track, bearing(live.lat, live.lon, n0.lat, n0.lon)) < 60)) {
          if (filed) v.flags.push({ cls: 'bad', text: `Low and descending toward ${n0.iata || n0.code}, not the filed destination ${destApt.iata || destApt.code} — possible diversion (FR24 will show the new destination once filed)` });
          else v.flags.push({ cls: 'warn', text: `Low and descending toward ${n0.iata || n0.code}; the usual-route destination ${destApt.iata || destApt.code} cannot be relied on for this flight` });
          v.conf = 'med';
        }
        if (!filed) v.destIsUsual = true;
      } else if (destApt && destApt.unknown) {
        v.airport = destApt; v.destIsFiled = true; v.conf = 'med'; v.evidence.push(`Destination ${codeOf(dest)} is not in the embedded airport database.`);
      } else {
        v.airport = n0; v.nearestOnly = true; v.dist = n0 ? n0.dist : null; v.conf = fresh ? 'med' : 'low';
        v.flags.push({ cls: 'warn', text: 'Destination unknown — showing the nearest airport to the current position' });
      }
    }
    return v;
  }
  if (leg) {
    v.via = 'FR24 flight history';
    if (leg.ended === false) {
      const dest = (leg.destActual && codeOf(leg.destActual)) ? leg.destActual : leg.dest;
      v.mode = 'air'; v.cls = 'air'; v.label = 'In flight · no live fix'; v.airport = aptByCodes(dest); v.destIsFiled = true; v.conf = 'med';
      v.evidence.push(`FR24 lists ${leg.flight || leg.callsign || 'a flight'} ${codeOf(leg.orig) || '?'} → ${codeOf(dest) || '?'} as live (first seen ${fmtTime(leg.firstSeen)}, last seen ${fmtTime(leg.lastSeen)}) but returned no current position — coverage gap or just landed.`);
      return v;
    }
    const landedAt = (leg.destActual && codeOf(leg.destActual)) ? leg.destActual : leg.dest;
    v.mode = 'ground'; v.airport = aptByCodes(landedAt);
    const refT = leg.landed || leg.lastSeen; const ageS = refT ? (now - refT) / 1000 : null;
    if (leg.landed) { v.cls = 'ground'; v.label = `On ground · since ${fmtTime(leg.landed)}`; v.conf = ageS != null && ageS < 3 * 86400 ? 'high' : 'med'; }
    else { v.cls = 'stale'; v.label = 'Last seen · landing not confirmed'; v.conf = 'low'; }
    v.evidence.push(`Last flight ${leg.flight || leg.callsign || '(no callsign)'} ${codeOf(leg.orig) || '?'} → ${codeOf(landedAt) || '?'}${leg.landed ? ` landed ${fmtTime(leg.landed)}${leg.rwyLanded ? ' RWY ' + leg.rwyLanded : ''} (${fmtAge(ageS)} ago)` : ` last seen ${fmtTime(leg.lastSeen)}`}.`, `No later flight recorded in the last ${settings.lookback} days and no live position — the aircraft has not moved under surveillance since.`);
    if (leg.destActual && codeOf(leg.destActual) && codeOf(leg.dest) && !sameApt(leg.destActual, leg.dest)) v.flags.push({ cls: 'bad', text: `DIVERTED — filed ${codeOf(leg.dest)}, landed ${codeOf(leg.destActual)}` });
    return v;
  }
  if (live && live.src) { v.via = live.src; v.evidence.push(`${live.src} has seen this aircraft recently but holds no position for it.`); }
  return v;
}
function angDiff(a, b) { let d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; }
/* Last position was on final approach and nothing followed: the aircraft landed there. */
function landingInferred(fix, n0, age) {
  if (!n0 || age < 600) return null;
  const elev = n0.elev || 0;
  const agl = typeof fix.alt === 'number' ? fix.alt - elev : (fix.alt === 'ground' ? 0 : null);
  if (agl == null || agl > 2500) return null;
  if (fix.gs != null && fix.gs > 200) return null;
  if (fix.vs != null && fix.vs > 300) return null;
  if (n0.dist > 10) return null;
  if (n0.dist > 5 && fix.track != null && angDiff(fix.track, bearing(fix.lat, fix.lon, n0.lat, n0.lon)) > 45) return null;
  return `last fix ${fmtTime(fix.t)} at ${fmtInt(agl)} ft above the field, ${fix.gs != null ? fmtInt(fix.gs) : '?'} kt, ${fmtDist(n0.dist)} from ${n0.iata || n0.code}, ${(fix.vs || 0) < -100 ? 'descending' : 'level'}; no transmission since — landed`;
}
function bestGuessLine(res, v) { const saved = v.checks; v.checks = null; const t = formatLine(res, v); v.checks = saved; return t; }
function fromAirport(res) {
  const live = res.live, leg = res.legs && res.legs[0];
  if (live && codeOf(live.orig)) { const a = aptByCodes(live.orig); if (a && !a.unknown) return a; }
  const mv = res.movements && res.movements.length ? res.movements[res.movements.length - 1] : null;
  if (mv && mv.how === 'inprogress' && mv.depApt) return mv.depApt;
  if (res.route && res.route.orig && codeOf(res.route.orig)) { const a = aptByCodes(res.route.orig); if (a && !a.unknown) return a; }
  if (leg && leg.ended === false && codeOf(leg.orig)) { const a = aptByCodes(leg.orig); if (a && !a.unknown) return a; }
  return null;
}
/* ---------- verification gate: the line is only produced when every check passes ---------- */
function verify(res, v) {
  const checks = []; const now = Date.now();
  const ok = (name, pass, detail) => checks.push({ name, ok: !!pass, detail });
  const live = res.live, key = regKey(res.reg);
  // 1. identity: every source that names a registration must name this one; registry hex must agree with sources
  const regNames = [...res.fixes.map(f => f.reg), res.traceMeta && res.traceMeta.reg, res.identity && res.identity.reg].filter(Boolean);
  const regMismatch = regNames.filter(r => regKey(r) !== key);
  const hexes = new Set([...res.fixes.map(f => f.hex), res.traceMeta && res.traceMeta.hex, res.identity && res.identity.hex].filter(Boolean).map(h => h.toUpperCase()));
  ok('Identity', regMismatch.length === 0 && hexes.size <= 1 && (regNames.length > 0), regMismatch.length ? `source reports ${regMismatch[0]}, not ${res.reg}` : hexes.size > 1 ? `conflicting Mode S codes ${[...hexes].join(', ')}` : regNames.length ? `${regNames.length} source${regNames.length > 1 ? 's' : ''} name ${res.reg}${hexes.size ? ', hex ' + [...hexes][0] : ''}` : 'no source confirms this registration');
  if (!live || !isFinite(live.lat)) {
    const leg = res.legs && res.legs[0];
    if (v.mode === 'ground' && leg && leg.ended !== false && leg.landed && v.airport && !v.airport.unknown) {
      const ageL = (now - leg.landed) / 1000;
      ok('Landing recorded', true, `FR24 recorded ${leg.flight || leg.callsign || 'the flight'} landing at ${v.airport.iata || v.airport.code} ${fmtTime(leg.landed)}`);
      ok('No later movement', res.legs.filter(l => (l.firstSeen || 0) > (leg.firstSeen || 0)).length === 0, 'no later flight in FR24 history');
      ok('Recent enough', ageL <= 3 * 86400, ageL <= 3 * 86400 ? `landed ${fmtAge(ageL)} ago` : `landed ${fmtAge(ageL)} ago — confirm manually`);
    } else ok('Position', false, 'no position fix from any source');
    v.checks = checks; v.verified = checks.every(c => c.ok); v.whyNot = v.verified ? '' : checks.filter(c => !c.ok).map(c => `${c.name}: ${c.detail}`).join('; '); return;
  }
  // 2. fix validity
  const age = (now - live.t) / 1000;
  const valid = Math.abs(live.lat) <= 90 && Math.abs(live.lon) <= 180 && !(Math.abs(live.lat) < 0.01 && Math.abs(live.lon) < 0.01) && age > -120 && age <= settings.lookback * 86400 + 86400;
  ok('Fix valid', valid, valid ? `${live.lat.toFixed(4)}, ${live.lon.toFixed(4)} · ${fmtAge(age)} old · ${live.src}` : 'implausible coordinates or timestamp');
  // 3. independent sources agree (when more than one is fresh)
  const freshFixes = res.fixes.filter(f => isFinite(f.lat) && (now - f.t) / 1000 <= FRESH_S);
  let agree = true, agreeDetail = `${freshFixes.length} live source${freshFixes.length === 1 ? '' : 's'}`;
  for (let i = 0; i < freshFixes.length; i++) for (let j = i + 1; j < freshFixes.length; j++) { const d = hav(freshFixes[i].lat, freshFixes[i].lon, freshFixes[j].lat, freshFixes[j].lon); const lim = v.mode === 'ground' ? 5 : 60; if (d > lim) { agree = false; agreeDetail = `${freshFixes[i].src} and ${freshFixes[j].src} disagree by ${fmtDist(d)}`; } }
  if (freshFixes.length > 1 && agree) agreeDetail = freshFixes.map(f => f.src).join(' + ') + ' agree';
  ok('Sources agree', agree, agreeDetail);
  if (v.mode === 'ground') {
    const a = v.airport;
    const inside = a && !a.unknown && v.dist != null && (v.dist <= a.radius || !!v.landingNote);
    // 4. geometry: inside one airport boundary, unambiguous
    const others = (v.nearest || []).slice(1).filter(n => n.dist <= n.radius && sizeRank(n) >= sizeRank(a));
    ok('Inside airport boundary', inside && others.length === 0, !a ? 'no airport near the fix' : !inside ? `${fmtDist(v.dist)} from ${a.iata || a.code}, outside its ${fmtDist(a.radius)} boundary` : others.length ? `also inside ${others[0].iata || others[0].code} — ambiguous` : `${fmtDist(v.dist)} from ${a.iata || a.code} reference, within ${fmtDist(a.radius)}`);
    // 5. ground state plausible
    const elev = a && a.elev != null ? a.elev : 0;
    const grounded = !!v.landingNote || live.alt === 'ground' || (typeof live.alt === 'number' && live.alt - elev <= 1500 && (live.gs == null || live.gs <= 60));
    ok('On-ground state', grounded, live.alt === 'ground' ? 'ground flag set by transponder' : v.landingNote ? 'landing inferred from final approach' : `${fmtInt(live.alt)} ft, ${live.gs != null ? fmtInt(live.gs) + ' kt' : 'speed n/a'}`);
    // 6. corroboration: a second source, a trace dwell, FR24's landing record, or an unambiguous final approach
    let corr = v.landingNote ? 'Landing inferred: ' + v.landingNote : '', why = 'single fix with nothing to corroborate it';
    if (freshFixes.length > 1 && agree && freshFixes.every(f => f.alt === 'ground' || (typeof f.alt === 'number' && f.alt - elev <= 1500))) corr = `${freshFixes.length} independent live sources`;
    if (!corr && res.tracePts && a) {
      let n = 0, first = null, last = null;
      for (let i = res.tracePts.length - 1; i >= 0; i--) { const p = res.tracePts[i]; if (!isGroundPt(p)) break; if (hav(p.lat, p.lon, a.lat, a.lon) > a.radius) break; n++; last = last || p.t; first = p.t; }
      if (n >= 3 && last - first >= 120000) corr = `trace shows ${n} ground positions at ${a.iata || a.code} over ${fmtAge((last - first) / 1000)} with no later movement`;
      else why = n ? `only ${n} ground position${n === 1 ? '' : 's'} in the trace at ${a.iata || a.code}` : 'trace does not end on the ground here';
    }
    if (!corr && res.legs && res.legs[0] && res.legs[0].ended !== false) { const l = res.legs[0]; const at = (l.destActual && codeOf(l.destActual)) ? l.destActual : l.dest; if (sameApt(at, aptCodes(a))) corr = `FR24 recorded the landing at ${codeOf(at)} ${fmtTime(l.landed)}`; }
    ok('Corroborated', !!corr, corr || why);
    // 7. freshness
    ok('Recent enough', age <= 3 * 86400, age <= 3 * 86400 ? `fix ${fmtAge(age)} old` : `fix ${fmtAge(age)} old — confirm manually`);
  } else if (v.mode === 'air') {
    ok('Fresh in-flight fix', age <= FRESH_S, age <= FRESH_S ? `${fmtAge(age)} old` : `track lost ${fmtAge(age)} ago`);
    const dest = v.destIsFiled && v.airport && !v.airport.unknown ? v.airport : null;
    const filed = !!(live.dest && codeOf(live.dest));
    ok('Destination known', !!dest, dest ? `${dest.iata || dest.code} ${filed ? 'filed (FR24)' : 'usual route for ' + (live.callsign || '?') + ' (' + (res.route ? res.route.src : '?') + ')'}` : 'no destination from any source');
    const from = fromAirport(res); const mv = res.movements && res.movements.length ? res.movements[res.movements.length - 1] : null;
    const fromActual = (live.orig && codeOf(live.orig)) || (mv && mv.how === 'inprogress' && mv.depApt && mv.depInside);
    ok('Departure observed', !!from && !!fromActual, from ? (fromActual ? `${from.iata || from.code} from the ${filed ? 'FR24 record' : 'trace'}` : `${from.iata || from.code} only from the route database`) : 'departure airport unknown');
    // route sanity: trace departure must match the route database origin when both exist
    const routeOrig = res.route && res.route.orig && codeOf(res.route.orig) ? aptByCodes(res.route.orig) : null;
    const traceDep = mv && mv.how === 'inprogress' && mv.depApt && mv.depInside ? mv.depApt : null;
    const routeOk = !routeOrig || !traceDep || routeOrig.code === traceDep.code || filed;
    ok('Route consistent', routeOk, routeOk ? (routeOrig && traceDep ? `route origin ${routeOrig.iata || routeOrig.code} matches observed departure` : 'nothing contradicts the route') : `route database says ${routeOrig.iata || routeOrig.code} → ${dest ? dest.iata || dest.code : '?'} but the aircraft departed ${traceDep.iata || traceDep.code} — callsign may be reused`);
    if (dest) { const brg = bearing(live.lat, live.lon, dest.lat, dest.lon); const d = hav(live.lat, live.lon, dest.lat, dest.lon); const heading = live.track == null || d < 150 || angDiff(live.track, brg) <= 90; ok('Heading toward destination', heading, live.track == null ? 'no track reported' : `track ${Math.round(live.track)}°, destination bears ${Math.round(brg)}°, ${fmtDist(d)}`); }
    ok('Destination consistent with track', !v.flags.some(f => /descending toward/.test(f.text)), v.flags.find(f => /descending toward/.test(f.text)) ? v.flags.find(f => /descending toward/.test(f.text)).text : (filed ? 'no diversion indicated by FR24 or by the track' : 'track consistent with the usual route'));
  } else { ok('Position', false, 'no usable position'); }
  v.checks = checks; v.verified = checks.every(c => c.ok); v.whyNot = v.verified ? '' : checks.filter(c => !c.ok).map(c => `${c.name}: ${c.detail}`).join('; ');
}
/* The one line the website needs. */
function formatLine(res, v) {
  if (v.checks && !v.verified) return `UNVERIFIED - manual check required - ${v.whyNot}`;
  const live = res.live;
  if (v.mode === 'ground' && v.airport) {
    const inside = v.dist == null || v.airport.unknown || v.dist <= (v.airport.radius || 0) || !!v.landingNote;
    return inside ? airportLine(v.airport) : `${airportLine(v.airport)} (nearest airport, ${fmtDist(v.dist)} away, position is off-airport)`;
  }
  if (v.mode === 'air') {
    const dest = v.destIsFiled && v.airport && !v.airport.unknown ? v.airport : null;
    const from = fromAirport(res);
    const near = v.nearest && v.nearest[0];
    const to = dest ? airportLine(dest) : `destination not available (airborne near ${near ? airportLine(near) : 'unknown position'})`;
    let s = `Currently en route to ${to} from ${from ? airportLine(from) : 'departure airport not available'}`;
    if (live && isFinite(live.lat) && (Date.now() - live.t) / 1000 > FRESH_S) s += ` (last seen ${fmtTime(live.t)}, track lost)`;
    return s;
  }
  return `No position data for ${res.reg} in the last ${settings.lookback} days`;
}

/* ---------- formatting ---------- */
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtInt = (n) => n == null || !isFinite(n) ? '—' : Math.round(n).toLocaleString('en-GB');
function fmtDist(km) { if (km == null || !isFinite(km)) return '—'; return settings.units === 'km' ? `${km < 10 ? km.toFixed(1) : Math.round(km)} km` : `${(km / 1.852) < 10 ? (km / 1.852).toFixed(1) : Math.round(km / 1.852)} nm`; }
function fmtAge(s) { if (s == null || !isFinite(s)) return 'unknown'; s = Math.max(0, Math.round(s)); if (s < 90) return `${s} s`; const m = Math.round(s / 60); if (m < 90) return `${m} min`; const h = s / 3600; if (h < 48) return `${h.toFixed(h < 10 ? 1 : 0)} h`; return `${Math.round(h / 24)} d`; }
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtTime(t) { if (!t) return 'n/a'; const d = new Date(t); const p = (n) => String(n).padStart(2, '0'); return `${p(d.getUTCDate())} ${MON[d.getUTCMonth()]} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}Z`; }
function fmtTimeShort(t) { if (!t) return '—'; const d = new Date(t); const p = (n) => String(n).padStart(2, '0'); return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}Z`; }
const CONF_TEXT = { high: 'High confidence', med: 'Medium confidence', low: 'Low confidence' };
const aptLabel = (a, inside) => a ? `${a.iata || a.code}${inside === false ? '?' : ''}` : '—';

/* ---------- render ---------- */
function render(res, v, idx) {
  const apt = v.airport;
  const big = apt ? (apt.iata || (apt.code ? apt.code : '—')) : '—';
  const noIata = apt && !apt.iata;
  const id = res.identity || {};
  const live = res.live, leg = res.legs && res.legs[0];
  const headline = (() => {
    if (!apt) return v.cls === 'none' ? `No position for ${res.reg} from any source checked.` : '';
    const name = apt.unknown ? `${codeOf(aptCodes(apt))}` : `${apt.name}`;
    if (v.mode === 'ground') return `${res.reg} is ${v.cls === 'ground' ? '' : 'probably '}at <b>${esc(name)}</b>${apt.city ? `, ${esc(apt.city)}` : ''}${apt.country ? ` (${esc(apt.country)})` : ''}.`;
    if (v.mode === 'air' && v.destIsFiled) return `${res.reg} ${v.cls === 'air' ? 'is airborne' : 'was last seen airborne'}, ${v.destIsUsual ? 'usually ' : ''}bound for <b>${esc(name)}</b>${apt.city ? `, ${esc(apt.city)}` : ''}${v.dist != null ? ` — ${fmtDist(v.dist)} to run` : ''}${live && live.eta ? `, ETA ${fmtTime(live.eta)}` : ''}.`;
    if (v.mode === 'air') return `${res.reg} ${v.cls === 'air' ? 'is' : 'was last seen'} airborne near <b>${esc(name)}</b>${v.dist != null ? ` (${fmtDist(v.dist)})` : ''}; destination not known.`;
    return '';
  })();
  const flags = v.flags.map(f => `<span class="flag ${esc(f.cls)}">${esc(f.text)}</span>`).join('');
  let movesHtml = '';
  if (res.legs && res.legs.length) {
    const rows = res.legs.slice(0, 10).map(l => {
      const act = (l.destActual && codeOf(l.destActual)) ? l.destActual : null; const div = act && codeOf(l.dest) && !sameApt(act, l.dest);
      return `<tr class="${l.ended === false ? 'live' : ''}"><td>${esc(fmtTimeShort(l.takeoff || l.firstSeen))}</td><td>${esc(l.flight || l.callsign || '—')}</td><td>${esc(codeOf(l.orig) || '—')} → ${div ? `<s>${esc(codeOf(l.dest))}</s> <span class="div">${esc(codeOf(act))}</span>` : esc(codeOf(act || l.dest) || '—')}</td><td>${l.ended === false ? '<span class="live">live</span>' : esc(fmtTimeShort(l.landed))}</td><td class="text">${div ? '<span class="div">diverted</span>' : (l.ended === false ? 'in progress' : (l.landed ? 'landed' : 'not confirmed'))}</td></tr>`;
    }).join('');
    movesHtml = `<div class="cell wide"><div class="eyebrow">Recent flights · FR24 · last ${settings.lookback} days</div><div class="scroll"><table class="legs"><thead><tr><th>Dep (UTC)</th><th>Flight</th><th>Route</th><th>Arr (UTC)</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
  } else if (res.movements && res.movements.length) {
    const rows = res.movements.slice(-10).reverse().map(m => {
      const usual = m.route && m.route.dest && codeOf(m.route.dest); const arr = m.arrApt; const odd = usual && arr && !sameApt(m.route.dest, aptCodes(arr));
      return `<tr class="${m.how === 'inprogress' ? 'live' : ''}"><td>${esc(fmtTimeShort(m.start))}</td><td>${esc(m.callsign || '—')}</td><td>${esc(aptLabel(m.depApt, m.depInside))} → ${m.how === 'landed' ? esc(aptLabel(arr, m.arrInside)) : (usual ? esc(usual) + '?' : '…')}</td><td>${m.how === 'landed' ? esc(fmtTimeShort(m.end)) : (m.how === 'inprogress' ? '<span class="live">live</span>' : esc(fmtTimeShort(m.end)))}</td><td class="text">${m.how === 'landed' ? (odd ? `landed (usual route ${esc(usual)})` : 'landed') : m.how === 'inprogress' ? 'in progress' : 'track lost airborne'}</td></tr>`;
    }).join('');
    movesHtml = `<div class="cell wide"><div class="eyebrow">Movements · adsb.lol traces · ${esc((res.traceDays || []).join(' + '))}</div><div class="scroll"><table class="legs"><thead><tr><th>Airborne (UTC)</th><th>Callsign</th><th>From → To</th><th>Landed (UTC)</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table></div><div class="note" style="margin-top:6px">Airports inferred from where each leg started and ended; "?" marks a point outside any airport boundary. "Usual" destinations come from community route databases, not filed plans.</div></div>`;
  }
  const route = (() => {
    const mv = res.movements && res.movements.length ? res.movements[res.movements.length - 1] : null;
    const o = live && codeOf(live.orig) ? live.orig : (res.route && res.route.orig) || (leg && leg.orig) || (mv && mv.depApt ? aptCodes(mv.depApt) : null);
    const d = live && codeOf(live.dest) ? live.dest : (res.route && res.route.dest) || (leg && leg.dest) || (mv && mv.arrApt ? aptCodes(mv.arrApt) : null);
    const da = leg && leg.destActual && codeOf(leg.destActual) && !sameApt(leg.destActual, leg.dest) && !(live && codeOf(live.dest)) ? leg.destActual : null;
    if (!o && !d) return '';
    return `<div class="route"><span>${esc(codeOf(o) || '?')}</span><span class="arr">→</span>${da ? `<span class="strike">${esc(codeOf(d))}</span><span class="act">${esc(codeOf(da))}</span>` : `<span>${esc(codeOf(d) || '?')}</span>`}</div>`;
  })();
  const flightLabel = live ? [live.flight, live.callsign].filter(Boolean).filter((x, i, a) => a.indexOf(x) === i).join(' · ') : (leg ? [leg.flight, leg.callsign].filter(Boolean).filter((x, i, a) => a.indexOf(x) === i).join(' · ') : '');
  const photo = res.photo ? `<a href="${esc(res.photo.link || '#')}" target="_blank" rel="noopener"><img class="photo" src="${esc(res.photo.src)}" alt="${esc(res.reg)} photo"></a><div class="note">${esc(res.photo.credit)}</div>` : (id.photo ? `<a href="${esc(id.photoLink || '#')}" target="_blank" rel="noopener"><img class="photo" src="${esc(id.photo)}" alt="${esc(res.reg)} photo"></a><div class="note">Photo via airport-data.com</div>` : '');
  const hex = (live && live.hex) || id.hex || (leg && leg.hex) || '';
  const links = [
    hex ? `<a href="https://globe.adsb.lol/?icao=${esc(hex.toLowerCase())}" target="_blank" rel="noopener">adsb.lol globe</a>` : '',
    hex ? `<a href="https://globe.airplanes.live/?icao=${esc(hex.toLowerCase())}" target="_blank" rel="noopener">airplanes.live globe</a>` : '',
    `<a href="https://www.flightradar24.com/data/aircraft/${esc(res.reg.toLowerCase())}" target="_blank" rel="noopener">Flightradar24</a>`,
    `<a href="https://www.flightaware.com/resources/registration/${esc(res.reg)}" target="_blank" rel="noopener">FlightAware</a>`,
    apt && !apt.unknown ? `<a href="https://www.google.com/maps/search/?api=1&query=${apt.lat},${apt.lon}" target="_blank" rel="noopener">${esc(apt.iata || apt.code)} on Google Maps</a>` : '',
    live && isFinite(live.lat) ? `<a href="https://www.google.com/maps/search/?api=1&query=${live.lat},${live.lon}" target="_blank" rel="noopener">Fix on Google Maps</a>` : ''
  ].filter(Boolean).join('');
  const srcLines = res.log.map(l => `<li>${esc(l)}</li>`).join('');
  const nearList = v.nearest && v.nearest.length ? `<div class="kv"><dt>Nearest</dt><dd>${v.nearest.map(n => `<span class="mono">${esc(n.iata || n.code)}</span> ${fmtDist(n.dist)}`).join(' · ')}</dd></div>` : '';
  const typeCode = id.type || (live && live.type) || '';
  const typeName = id.typeName || (live && live.desc) || '';
  return `
<article class="card result-card" id="card-${idx}">
  <div class="head">
    <div class="verdict">
      <div class="reg-row">
        <div class="reg">${esc(res.reg)}${typeCode ? `<small>${esc(typeCode)}${id.operator ? ' · ' + esc(id.operator) : ''}</small>` : ''}</div>
        <span class="status ${esc(v.cls)}">${esc(v.label)}</span>
      </div>
      <div class="board">
        <div class="iata ${!apt ? 'dim' : ''}" title="${esc(noIata ? 'ICAO code — this airport has no IATA code' : 'IATA code')}">${esc(big)}</div>
        <div class="apt">
          ${apt ? `<div class="name">${esc(apt.unknown ? 'Airport not in database' : apt.name)}</div>
          <div class="meta">${apt.code ? `<span>ICAO <span class="mono">${esc(apt.code)}</span></span>` : ''}${apt.iata ? `<span>IATA <span class="mono">${esc(apt.iata)}</span></span>` : (noIata ? '<span class="flag warn">no IATA code</span>' : '')}${apt.city ? `<span>${esc(apt.city)}${apt.country ? ', ' + esc(apt.country) : ''}</span>` : ''}${apt.elev != null ? `<span>elev <span class="mono">${fmtInt(apt.elev)} ft</span></span>` : ''}</div>` : `<div class="name">${v.cls === 'none' ? 'Unknown' : ''}</div>`}
          <div class="flags">${v.checks ? (v.verified ? '<span class="flag good">verified</span>' : '<span class="flag bad">UNVERIFIED — ' + esc(v.whyNot) + '</span>') : ''}${v.destIsFiled ? `<span class="flag air">${v.destIsUsual ? 'usual destination' : 'filed destination'}</span>` : ''}${v.nearestOnly ? '<span class="flag warn">nearest airport only</span>' : ''}${flags}</div>
        </div>
      </div>
      <div class="summary">${headline || esc(v.evidence[0] || '')}</div>
      <div class="conf ${esc(v.conf)}"><span class="bar"><i></i><i></i><i></i></span><span>${CONF_TEXT[v.conf]}${v.via ? ` · via ${esc(v.via)}` : ''}</span></div>
    </div>
    <div class="map-pane"><div class="map" id="map-${idx}"></div><div class="nomap" id="nomap-${idx}" hidden>No position to plot</div></div>
  </div>
  <div class="detail">
    <div class="cell">
      <div class="eyebrow">Flight</div>
      ${route || '<div class="note">No route information.</div>'}
      <dl class="kv">
        ${flightLabel ? `<dt>Ident</dt><dd class="mono">${esc(flightLabel)}</dd>` : ''}
        ${live && isFinite(live.lat) ? `<dt>Fix</dt><dd class="mono">${live.lat.toFixed(4)}, ${live.lon.toFixed(4)}</dd><dt>Fix time</dt><dd class="mono">${esc(fmtTime(live.t))} <span class="note">(${esc(fmtAge((Date.now() - live.t) / 1000))} ago)</span></dd>` : ''}
        ${live && live.alt != null ? `<dt>Altitude</dt><dd class="mono">${live.alt === 'ground' ? 'ground' : fmtInt(live.alt) + ' ft'}${live.vs ? ` <span class="note">${live.vs > 0 ? '+' : ''}${fmtInt(live.vs)} fpm</span>` : ''}</dd>` : ''}
        ${live && live.gs != null ? `<dt>Speed / track</dt><dd class="mono">${fmtInt(live.gs)} kt${live.track != null ? ` / ${String(Math.round(live.track)).padStart(3, '0')}°` : ''}</dd>` : ''}
        ${live && live.squawk ? `<dt>Squawk</dt><dd class="mono">${esc(live.squawk)}${live.squawk === '7700' ? ' <span class="flag bad">EMERGENCY</span>' : live.squawk === '7600' ? ' <span class="flag bad">RADIO FAILURE</span>' : live.squawk === '7500' ? ' <span class="flag bad">7500</span>' : ''}</dd>` : ''}
        ${live && live.eta ? `<dt>ETA</dt><dd class="mono">${esc(fmtTime(live.eta))}</dd>` : ''}
      </dl>
      ${nearList}
    </div>
    <div class="cell">
      <div class="eyebrow">Why this answer</div>
      <ul class="evidence">${v.evidence.map(e => `<li>${esc(e)}</li>`).join('') || '<li>No evidence collected.</li>'}</ul>
      <div class="eyebrow" style="margin-top:6px">Sources this lookup</div>
      <ul class="evidence note">${srcLines}</ul>
    </div>
    <div class="cell">
      <div class="eyebrow">Aircraft</div>
      ${photo}
      <dl class="kv">
        <dt>Registration</dt><dd class="mono">${esc(res.reg)}</dd>
        ${hex ? `<dt>Mode S</dt><dd class="mono">${esc(hex)}</dd>` : ''}
        ${typeCode ? `<dt>Type</dt><dd><span class="mono">${esc(typeCode)}</span>${typeName ? ` · ${esc(typeName)}` : ''}</dd>` : ''}
        ${id.operator ? `<dt>Operator</dt><dd>${esc(id.operator)}${id.opFlag ? ` <span class="mono note">${esc(id.opFlag)}</span>` : ''}</dd>` : (live && live.operator ? `<dt>Operating as</dt><dd class="mono">${esc(live.operator)}</dd>` : '')}
        ${id.country ? `<dt>Registered</dt><dd>${esc(id.country)}</dd>` : ''}
      </dl>
      <div class="links">${links}</div>
    </div>
    ${movesHtml}
  </div>
</article>`;
}

/* ---------- map ---------- */
const maps = new Map();
function isDark() { return false; }
function drawMap(idx, res, v) {
  const el = $(`map-${idx}`), nomap = $(`nomap-${idx}`);
  if (!el) return;
  const live = res.live; const apt = v.airport && !v.airport.unknown && isFinite(v.airport.lat) ? v.airport : null;
  const havePos = live && isFinite(live.lat);
  if ((!havePos && !apt) || typeof L === 'undefined') { nomap.hidden = false; nomap.textContent = typeof L === 'undefined' ? 'Map library did not load (offline?)' : 'No position to plot'; return; }
  nomap.hidden = true;
  const map = L.map(el, { zoomControl: true, attributionControl: true, scrollWheelZoom: false });
  maps.set(idx, map);
  L.tileLayer(`https://{s}.basemaps.cartocdn.com/${isDark() ? 'dark_all' : 'light_all'}/{z}/{x}/{y}{r}.png`, { maxZoom: 19, subdomains: 'abcd', attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>' }).addTo(map);
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const pts = [];
  if (apt) {
    L.marker([apt.lat, apt.lon], { icon: L.divIcon({ className: '', html: `<div class="apt-icon ${v.destIsFiled ? 'dest' : ''}"></div>`, iconSize: [14, 14], iconAnchor: [7, 7] }) }).addTo(map).bindPopup(`<b>${esc(apt.iata || apt.code)}</b> ${esc(apt.name)}${v.destIsFiled ? '<br>destination' : ''}`);
    if (apt.radius) L.circle([apt.lat, apt.lon], { radius: apt.radius * 1000, color: css(v.destIsFiled ? '--air' : '--good'), weight: 1, fillOpacity: .06 }).addTo(map);
    pts.push([apt.lat, apt.lon]);
  }
  if (v.nearest) for (const n of v.nearest.slice(1)) { if (!apt || n.code !== apt.code) L.marker([n.lat, n.lon], { icon: L.divIcon({ className: '', html: '<div class="apt-icon near"></div>', iconSize: [10, 10], iconAnchor: [5, 5] }) }).addTo(map).bindPopup(`<b>${esc(n.iata || n.code)}</b> ${esc(n.name)}<br>${fmtDist(n.dist)} from fix`); }
  if (res.trail && res.trail.length > 1) L.polyline(res.trail, { color: css('--accent'), weight: 2, opacity: .7 }).addTo(map);
  if (havePos) {
    const rot = live.track != null ? live.track : 0;
    const icon = L.divIcon({ className: '', html: `<div class="ac-icon" style="transform:rotate(${rot}deg)"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 16v-2l-8-5V3.5A1.5 1.5 0 0 0 11.5 2 1.5 1.5 0 0 0 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5z"/></svg></div>`, iconSize: [26, 26], iconAnchor: [13, 13] });
    L.marker([live.lat, live.lon], { icon }).addTo(map).bindPopup(`<b>${esc(res.reg)}</b> ${esc(live.callsign || '')}<br>${live.alt === 'ground' ? 'on ground' : (live.alt != null ? fmtInt(live.alt) + ' ft' : '')}${live.gs != null ? ', ' + fmtInt(live.gs) + ' kt' : ''}<br>${esc(fmtTime(live.t))}`);
    pts.push([live.lat, live.lon]);
    if (apt && v.destIsFiled) L.polyline([[live.lat, live.lon], [apt.lat, apt.lon]], { color: css('--air'), weight: 1.5, dashArray: '4 6', opacity: .8 }).addTo(map);
  }
  if (pts.length === 1) map.setView(pts[0], v.mode === 'ground' ? 13 : 9); else map.fitBounds(L.latLngBounds(pts).pad(0.25));
  setTimeout(() => map.invalidateSize(), 50);
}

/* ---------- simple view ---------- */
function renderSimple(items) {
  const el = $('simple');
  el.innerHTML = items.map((it, i) => {
    const v = it.verdict, text = it.line;
    const age = it.live && it.live.t ? `fix ${fmtAge((Date.now() - it.live.t) / 1000)} old via ${it.live.src}` : 'no position fix';
    const passed = (v.checks || []).filter(c => c.ok).length, total = (v.checks || []).length;
    const checks = (v.checks || []).map(c => `<li class="${c.ok ? 'ok' : 'bad'}"><b>${c.ok ? '✓' : '✗'}</b><span>${esc(c.name)}</span><span class="d">${esc(c.detail)}</span></li>`).join('');
    const guess = !v.verified && v.cls !== 'none' ? `<div class="sumsec amber"><div class="h">Best available reading — not verified, do not use unconfirmed</div><p class="mono">${esc(it.best || bestGuessLine(it, v))}</p></div>` : '';
    return `<div class="line-card">
  <div class="verdict-box ${v.verified ? 'pass' : 'fail'}">
    <span class="badge-lg">${v.verified ? 'VERIFIED' : 'UNVERIFIED'}</span>
    <span class="reg">${esc(it.reg)}</span>
    <span class="status ${esc(v.cls)}">${esc(v.label)}</span>
    ${it.diverted ? `<span class="status diverted">DIVERTED${it.divertedFrom ? ' · filed ' + esc(it.divertedFrom) : ''}</span>` : ''}
    <span class="meta">${esc(age)} · ${passed}/${total} checks passed · ${CONF_TEXT[v.conf].toLowerCase()}${it.provider ? ' · ' + esc(it.provider) : ''}</span>
  </div>
  <div class="line-row"><input class="line ${v.verified ? '' : 'none'}" id="line-${i}" readonly value="${esc(text)}" aria-label="Location line for ${esc(it.reg)}"><button class="btn copy" type="button" data-copy="${i}">Copy</button></div>
  ${guess}
  <details class="allchecks"><summary>Verification checks (${passed}/${total} passed)</summary><div class="inner"><ul class="checks">${checks}</ul></div></details>
</div>`;
  }).join('');
}
const VIEWS = ['simple', 'full', 'dev', 'settings'];
function setView(view) {
  if (!VIEWS.includes(view)) view = 'simple';
  for (const v of VIEWS) document.body.classList.toggle('view-' + v, v === view);
  for (const [id, v] of [['tabSimple', 'simple'], ['tabFull', 'full'], ['tabDev', 'dev'], ['tabSettings', 'settings']]) $(id).setAttribute('aria-selected', String(v === view));
  LS.set('view', view);
  for (const m of maps.values()) { try { setTimeout(() => m.invalidateSize(), 60); } catch {} }
}
async function copyText(text, btn) {
  try { await navigator.clipboard.writeText(text); } catch { const inp = btn && btn.parentElement.querySelector('input'); if (inp) { inp.focus(); inp.select(); try { document.execCommand('copy'); } catch {} } }
  if (btn) { btn.textContent = 'Copied'; btn.classList.add('done'); setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('done'); }, 1600); }
}
function postResults(items) {
  const msg = { type: 'tail-locator', results: items.map(it => ({ reg: it.reg, text: it.line, verified: !!it.verdict.verified, status: it.verdict.mode === 'ground' ? 'ground' : it.verdict.mode === 'air' ? 'enroute' : 'unknown', label: it.verdict.label, confidence: it.verdict.conf, checks: it.verdict.checks || [] })) };
  try { if (window.opener && window.opener !== window) window.opener.postMessage(msg, '*'); } catch {}
  try { if (window.parent && window.parent !== window) window.parent.postMessage(msg, '*'); } catch {}
}
const SITE_SNIPPET = `<!-- on your page -->
<input id="acLocation" placeholder="Aircraft location">
<script>
async function fillAircraftLocation(reg) {
  const r = await fetch('__BASE__/locate?reg=' + encodeURIComponent(reg));
  const j = await r.json();            // j.text = "SNN - Shannon Airport - Ireland"
  document.getElementById('acLocation').value = j.text;   // or "Currently en route to ... from ..."
}
fillAircraftLocation('EI-DEI');
<\/script>`;

/* ---------- server engine (same answer the website gets) ---------- */
const STATUS_LABEL = { ground: 'On ground', ground_off_airport: 'On ground · off-airport', enroute: 'In flight', enroute_stale: 'Last seen in flight', unknown: 'No position data' };
const STATUS_CLS = { ground: 'ground', ground_off_airport: 'stale', enroute: 'air', enroute_stale: 'stale', unknown: 'none' };
async function serverLocate(regs) {
  // the Flightradar24 token from Settings rides along so the server engine can use it when it has no key of its own
  const hdr = settings.fr24Key ? { headers: { 'X-FR24-Key': settings.fr24Key } } : {};
  const j = await getJSON(`${state.serverLocate}?reg=${encodeURIComponent(regs.join(','))}&days=${settings.lookback}`, hdr, 180000);
  return (j.results || []).map(r => ({ reg: r.reg, line: r.text, provider: r.provider || '', diverted: !!r.diverted, divertedFrom: r.diverted_from || '', live: r.fix && typeof r.fix.age_s === 'number' ? { lat: r.fix.lat, t: Date.now() - r.fix.age_s * 1000, src: r.fix.source } : null,
    verdict: { verified: !!r.verified, checks: r.checks || [], cls: STATUS_CLS[r.status] || 'none', label: STATUS_LABEL[r.status] + (r.since_utc ? ' · since ' + fmtTime(Date.parse(r.since_utc)) : ''), conf: r.confidence === 'high' ? 'high' : r.confidence === 'medium' ? 'med' : 'low', mode: r.status.startsWith('ground') ? 'ground' : r.status.startsWith('enroute') ? 'air' : 'none', via: r.fix ? r.fix.source : '', whyNot: '' },
    best: r.best_guess, log: r.log || [] }));
}

/* ---------- lookup orchestration ---------- */
let runToken = 0;
function fresher(a, b) { if (!a) return b; if (!b) return a; return (b.t || 0) > (a.t || 0) + 5000 ? b : a; }
async function locate(text, { fromUser = true } = {}) {
  const regs = parseInput(text);
  if (!regs.length) return;
  const token = ++runToken;
  const progress = $('progress'), ptext = $('progressText'), results = $('results');
  progress.classList.add('on'); $('goBtn').disabled = true;
  for (const m of maps.values()) { try { m.remove(); } catch {} } maps.clear();
  results.innerHTML = ''; $('simple').innerHTML = '';
  fr24Credits = 0;
  const say = (s) => { if (token === runToken) ptext.textContent = s; };
  const items = regs.map(reg => ({ reg, variants: regVariants(reg), hex: '', identity: null, live: null, fixes: [], tracePts: null, legs: [], movements: [], traceDays: [], trail: null, route: null, photo: null, log: [] }));
  const logAll = (s) => items.forEach(it => it.log.push(s));
  let serverP = null;
  if (state.serverLocate) { $('simple').innerHTML = '<p class="note">Asking the server engine…</p>'; serverP = serverLocate(regs).catch(e => { logAll('Server engine: ' + e.message); return null; }); }
  try {
    // 1) identity (keyless, parallel)
    say(`Resolving identity for ${regs.length} registration${regs.length > 1 ? 's' : ''}…`);
    await Promise.all(items.map(async it => { it.identity = await identity(it.reg); if (it.identity) { it.hex = it.identity.hex || ''; it.log.push(`Registry: ${it.identity.type || 'type n/a'}${it.identity.operator ? ' · ' + it.identity.operator : ''} · hex ${it.hex || 'n/a'} (${it.identity.src})`); } else it.log.push('Registry: no match for this registration (adsbdb, hexdb)'); }));
    if (token !== runToken) return;
    // 2) free live sources via relay
    if (haveRelay()) {
      say(`Live ADS-B via ${relayName()}: adsb.lol, airplanes.live, adsb.fi…`);
      const found = await aggregatorLookup(items, (s) => logAll(s));
      for (const it of items) { const fs = (found.get(regKey(it.reg)) || []).filter(f => isFinite(f.lat)); it.fixes.push(...fs); for (const f of fs) { it.live = fresher(it.live, f); it.hex = it.hex || f.hex; } }
      if (token !== runToken) return;
      say('OpenSky live states…'); const os = await openskyLookup(items, (s) => logAll(s));
      for (const it of items) { const f = os.get(regKey(it.reg)); if (f) { it.fixes.push(f); it.live = fresher(it.live, f); } }
      if (token !== runToken) return;
    } else logAll('No relay: start tail_locator.py (free) or set a cloud relay — live ADS-B feeds refuse direct browser calls');
    // 3) FR24 (optional, paid)
    if (settings.fr24Key) {
      say('Flightradar24 (optional): live positions…');
      try {
        const live = await fr24Live(items.map(it => it.reg));
        const hit = new Set();
        for (const f of live) { const it = items.find(x => regKey(x.reg) === regKey(f.reg)) || items.find(x => x.hex && f.hex && x.hex.toUpperCase() === f.hex.toUpperCase()); if (it) { it.fixes.push(f); it.live = fresher(it.live, f); it.hex = it.hex || (f.hex || '').toUpperCase(); hit.add(it); } }
        const miss = items.filter(it => !hit.has(it) && it.variants[1]);
        if (miss.length) { const live2 = await fr24Live(miss.map(it => it.variants[1])); for (const f of live2) { const it = miss.find(x => regKey(x.reg) === regKey(f.reg)); if (it) { it.live = fresher(it.live, f); hit.add(it); } } }
        for (const it of items) it.log.push(hit.has(it) ? `FR24 live: tracked, ${it.live.flight || it.live.callsign || 'no callsign'}` : 'FR24 live: not currently tracked');
      } catch (e) { logAll(`FR24 live: ${e.message}`); }
      if (token !== runToken) return;
      say(`Flightradar24: flights in the last ${settings.lookback} days…`);
      try {
        const legs = await fr24Summary(items.map(it => it.reg), settings.lookback);
        for (const it of items) it.legs = legs.filter(l => regKey(l.reg) === regKey(it.reg) || (it.hex && l.hex && l.hex.toUpperCase() === it.hex.toUpperCase()));
        const miss = items.filter(it => !it.legs.length && it.variants[1]);
        if (miss.length) { const legs2 = await fr24Summary(miss.map(it => it.variants[1]), settings.lookback); for (const it of miss) it.legs = legs2.filter(l => regKey(l.reg) === regKey(it.reg)); }
        for (const it of items) it.log.push(it.legs.length ? `FR24 history: ${it.legs.length} flight${it.legs.length > 1 ? 's' : ''}, latest ${it.legs[0].flight || it.legs[0].callsign || '—'} ${codeOf(it.legs[0].orig) || '?'}→${codeOf((it.legs[0].destActual && codeOf(it.legs[0].destActual)) ? it.legs[0].destActual : it.legs[0].dest) || '?'}` : `FR24 history: no flights in the last ${settings.lookback} days`);
      } catch (e) { logAll(`FR24 history: ${e.message}`); }
      logAll(`FR24 credits this lookup ≈ ${fr24Credits}`);
    }
    if (token !== runToken) return;
    // 4) free history: adsb.lol traces for anything without a fresh fix (sequential; files can be large)
    if (haveRelay()) {
      for (const it of items) {
        const fresh = it.live && isFinite(it.live.lat) && (Date.now() - it.live.t) < FRESH_S * 1000;
        if (fresh && it.legs.length) continue;
        say(`adsb.lol trace history for ${it.reg}…`);
        const tr = await traceLookup(it, (s) => it.log.push(s));
        if (token !== runToken) return;
        if (tr) {
          it.traceDays = tr.days; it.tracePts = tr.pts; it.traceMeta = tr.meta; it.movements = legsFromPoints(tr.pts);
          it.trail = tr.pts.slice(-400).map(p => [p.lat, p.lon]);
          if (!it.hex) it.hex = tr.meta.hex;
          if (!it.identity && (tr.meta.type || tr.meta.desc)) it.identity = { hex: tr.meta.hex, type: tr.meta.type, typeName: tr.meta.desc, operator: '', opFlag: '', country: '', photo: '', photoLink: '', reg: tr.meta.reg || it.reg, src: 'adsb.lol trace' };
          const fix = lastPointAsFix(tr);
          if (fix && (!it.live || !isFinite(it.live.lat) || fix.t > it.live.t + 5000)) it.live = fix;
          if (it.movements.length) { const m = it.movements[it.movements.length - 1]; it.log.push(`Traces: ${it.movements.length} movement${it.movements.length > 1 ? 's' : ''}, last ${m.callsign || '—'} ${aptLabel(m.depApt, m.depInside)} → ${m.how === 'landed' ? aptLabel(m.arrApt, m.arrInside) : (m.how === 'inprogress' ? 'in progress' : 'lost')}`); }
        }
      }
    }
    if (token !== runToken) return;
    // 5) routes (usual destination for a callsign) and photos
    say('Routes and photos…');
    await Promise.all(items.map(async it => {
      if (it.live && !codeOf(it.live.dest) && it.live.callsign) { it.route = await routeFor(it.live.callsign); if (it.route) it.log.push(`Route for ${it.live.callsign}: ${codeOf(it.route.orig)}→${codeOf(it.route.dest)} (${it.route.src})`); }
      const lastMv = it.movements[it.movements.length - 1];
      if (lastMv && lastMv.callsign) lastMv.route = (it.route && it.live && normCallsign(lastMv.callsign) === normCallsign(it.live.callsign || '')) ? it.route : await routeFor(lastMv.callsign);
      it.photo = await photoFor(it.reg);
    }));
    if (token !== runToken) return;
    // 6) decide + render
    const serverItems = serverP ? await serverP : null;
    if (token !== runToken) return;
    if (serverItems && serverItems.length) logAll('Lookup line taken from the server engine (/locate), which uses Flightradar24 as the primary source when a key is configured (FlightAware as fallback)');
    results.innerHTML = items.map((it, i) => { it.verdict = decide(it); verify(it, it.verdict); it.line = formatLine(it, it.verdict); return render(it, it.verdict, i); }).join('');
    items.forEach((it, i) => drawMap(i, it, it.verdict));
    if (serverItems && serverItems.length) { renderSimple(serverItems); postResults(serverItems); }
    else { renderSimple(items); postResults(items); }
    if (fromUser) { LS.set('recent', [...new Set([...regs, ...LS.get('recent', [])])].slice(0, 12)); renderRecent(); }
    try { history.replaceState(null, '', '#' + (document.body.classList.contains('view-simple') ? 'simple=' : '') + regs.join(',')); } catch {}
  } catch (e) {
    results.innerHTML = `<article class="card error"><h3>Lookup failed</h3><div>${esc(e.message || e)}</div></article>`;
    $('simple').innerHTML = `<div class="verdict-box fail"><span class="badge-lg">ERROR</span><p>${esc(e.message || e)}</p></div>`;
  } finally {
    if (token === runToken) { progress.classList.remove('on'); $('goBtn').disabled = false; }
  }
}

/* ---------- settings UI ---------- */
const WORKER_CODE = `// Cloudflare Worker — CORS relay for the free ADS-B feeds (Cloudflare's free plan is plenty).
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
};`;
function refreshSettingsUI() {
  const hasKey = !!settings.fr24Key, hasCloud = !!settings.cloudRelay, local = !!state.localRelay;
  const dotRelay = $('dotRelay'); dotRelay.className = 'dot ' + (local || hasCloud ? 'on' : 'off'); dotRelay.textContent = local ? 'Local relay' : hasCloud ? 'Cloud relay' : 'No relay';
  const fr24On = hasKey || !!state.fr24Server;
  $('dotFr24').className = 'dot ' + (fr24On ? 'on' : 'off'); $('dotFr24').textContent = fr24On ? (state.fr24ServerKey ? 'FR24 (server key)' : settings.sandbox ? 'FR24 sandbox' : 'FR24') : 'FR24 off';
  const fs = $('fr24ServerState'); if (fs) fs.textContent = state.fr24ServerKey ? 'The server has its own Flightradar24 key (FR24_KEY) — every lookup already uses Flightradar24 as the primary source. A key entered below is only needed for the Full-detail view in this browser.' : state.localRelay ? 'The server has no Flightradar24 key. A token entered below is stored in this browser and sent with each lookup, so the server engine uses it too. To make it permanent for everyone, set FR24_KEY in the server environment (Render → Environment) or put it in a file named fr24.key next to tail_locator.py.' : 'Start the server (tail_locator.py) or open the hosted page; the token below is then sent with each lookup.';
  const fa = $('dotFA'); if (fa) { fa.className = 'dot ' + (state.flightaware ? 'on' : 'off'); fa.textContent = state.flightaware ? 'FlightAware' : 'FlightAware off'; }
  $('fr24Badge').hidden = !hasKey; $('relayBadge').hidden = !(local || hasCloud); $('relayBadge').textContent = local ? 'local relay connected' : 'cloud relay set';
  $('localState').textContent = local ? `Connected — this page is being served by tail_locator.py at ${location.origin}.` : (/^https?:$/.test(location.protocol) ? 'Not detected. Start tail_locator.py and open the address it prints (http://127.0.0.1:8765/).' : 'Not detected. You opened the HTML file directly; start tail_locator.py and use the address it prints instead, or set a cloud relay below.');
  $('settingsSummary').textContent = `${local ? 'local relay' : hasCloud ? 'cloud relay' : 'no relay'} · ${settings.lookback}-day history · Flightradar24 ${fr24On ? (state.fr24ServerKey ? 'on (server key)' : 'on') : 'off — free data only'}`;
  $('hintText').textContent = local || hasCloud ? 'Up to 15 registrations per lookup. Press Enter or wait for auto-locate.' : 'No relay yet: run tail_locator.py (free) and open the address it prints. Identity lookups still work without it.';
}
function initSettings() {
  $('fr24Key').value = settings.fr24Key; $('fr24Sandbox').checked = settings.sandbox; $('relayUrl').value = settings.cloudRelay; $('lookback').value = String(settings.lookback); $('units').value = settings.units; $('autoRun').checked = settings.autoRun;
  $('workerCode').textContent = WORKER_CODE;
  $('fr24Key').addEventListener('change', () => { LS.set('fr24Key', $('fr24Key').value.trim()); refreshSettingsUI(); });
  $('fr24Sandbox').addEventListener('change', () => { LS.set('fr24Sandbox', $('fr24Sandbox').checked); refreshSettingsUI(); });
  $('relayUrl').addEventListener('change', () => { LS.set('relay', $('relayUrl').value.trim()); refreshSettingsUI(); });
  $('lookback').addEventListener('change', () => { LS.set('lookback', Number($('lookback').value)); refreshSettingsUI(); });
  $('units').addEventListener('change', () => LS.set('units', $('units').value));
  $('autoRun').addEventListener('change', () => LS.set('autoRun', $('autoRun').checked));
  $('fr24Clear').addEventListener('click', () => { LS.del('fr24Key'); $('fr24Key').value = ''; $('fr24Out').textContent = 'Key removed from this browser.'; $('fr24Out').className = 'test-out'; refreshSettingsUI(); });
  $('fr24Test').addEventListener('click', async () => {
    LS.set('fr24Key', $('fr24Key').value.trim()); refreshSettingsUI();
    const out = $('fr24Out'); out.className = 'test-out'; out.textContent = 'Testing…';
    try { const j = await fr24('/static/airports/EINN/light'); out.className = 'test-out ok'; out.textContent = `OK — ${j.name || 'airport lookup succeeded'} (${j.icao || 'EINN'}/${j.iata || 'SNN'}). ${settings.sandbox ? 'Sandbox keys return fixed sample data for every query.' : 'Key accepted.'}`; }
    catch (e) { out.className = 'test-out bad'; out.textContent = e.message + (e.code === 'network' ? ' — browser could not reach fr24api.flightradar24.com' : ''); }
  });
  $('fr24Usage').addEventListener('click', async () => {
    const out = $('fr24Out'); out.className = 'test-out'; out.textContent = 'Fetching usage…';
    try { const j = await fr24('/usage', { period: '24h' }); const rows = Array.isArray(j.data) ? j.data : []; const total = rows.reduce((s, r) => s + (Number(r.credits) || 0), 0); out.className = 'test-out ok'; out.textContent = rows.length ? `Last 24 h: ${total} credits across ${rows.reduce((s, r) => s + (Number(r.request_count) || 0), 0)} requests\n` + rows.map(r => `${r.endpoint}: ${r.request_count} req, ${r.credits} credits`).join('\n') : 'No usage recorded in the last 24 h.'; }
    catch (e) { out.className = 'test-out bad'; out.textContent = e.message; }
  });
  $('relayTest').addEventListener('click', async () => {
    LS.set('relay', $('relayUrl').value.trim()); refreshSettingsUI();
    const out = $('relayOut'); out.className = 'test-out'; out.textContent = `Testing ${relayName() || 'relay'} against adsb.lol…`;
    try { if (!haveRelay()) throw new SrcError('no_relay', 'No relay: start tail_locator.py or enter a cloud relay URL.'); const j = await getJSON(relayUrl('https://api.adsb.lol/v2/hex/4CA281'), {}, 15000); if (j && Array.isArray(j.ac)) { out.className = 'test-out ok'; out.textContent = `${relayName()} OK — adsb.lol answered (${j.total != null ? j.total + ' aircraft matched' : 'live data'}).`; } else throw new SrcError('shape', 'Relay answered, but not with adsb.lol JSON — check the worker code.'); }
    catch (e) { out.className = 'test-out bad'; out.textContent = e.message; }
  });
  $('relayCopy').addEventListener('click', async () => {
    const out = $('relayOut');
    try { await navigator.clipboard.writeText(WORKER_CODE); out.className = 'test-out ok'; out.textContent = 'Worker code copied.'; }
    catch { out.className = 'test-out'; out.textContent = 'Clipboard blocked — open the worker code below and copy it manually.'; $('workerCode').parentElement.open = true; }
  });
  refreshSettingsUI();
}

/* ---------- misc UI ---------- */
function renderRecent() {
  const r = LS.get('recent', []); const el = $('recent');
  el.innerHTML = r.length ? '<span class="note">Recent:</span> ' + r.map(x => `<button class="chip" type="button" data-reg="${esc(x)}">${esc(x)}</button>`).join('') : '';
}
function tickClock() { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); $('utcClock').textContent = `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`; }
async function init() {
  initSettings(); renderRecent(); tickClock(); setInterval(tickClock, 1000);
  const input = $('regInput'); let timer = null;
  $('goBtn').addEventListener('click', () => locate(input.value));
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); clearTimeout(timer); locate(input.value); } });
  input.addEventListener('input', () => { clearTimeout(timer); if (!$('autoRun').checked) return; const regs = parseInput(input.value); if (regs.length && regs.every(r => regKey(r).length >= 4)) timer = setTimeout(() => locate(input.value), 1200); });
  input.addEventListener('paste', () => { clearTimeout(timer); setTimeout(() => locate(input.value), 150); });
  $('recent').addEventListener('click', (e) => { const b = e.target.closest('[data-reg]'); if (b) { input.value = b.dataset.reg; locate(b.dataset.reg); } });
  $('tabSimple').addEventListener('click', () => setView('simple')); $('tabFull').addEventListener('click', () => setView('full')); $('tabDev').addEventListener('click', () => setView('dev')); $('tabSettings').addEventListener('click', () => setView('settings'));
  $('simple').addEventListener('click', (e) => { const b = e.target.closest('[data-copy]'); if (b) { const inp = $('line-' + b.dataset.copy); copyText(inp ? inp.value : '', b); return; } const inp = e.target.closest('input.line'); if (inp) inp.select(); });
  const lu = $('locateUrl'); if (lu) lu.textContent = (/^https?:$/.test(location.protocol) ? location.origin : 'http://127.0.0.1:8765') + '/locate?reg=EI-DEI';
  $('siteSnippet').textContent = SITE_SNIPPET.replace('<\\/script>', '</script>').replace('__BASE__', /^https?:$/.test(location.protocol) ? location.origin : 'http://127.0.0.1:8765');
  let h = decodeURIComponent((location.hash || '').slice(1)); let forced = '';
  if (/^simple=/i.test(h)) { forced = 'simple'; h = h.replace(/^simple=/i, ''); } else if (/^full=/i.test(h)) { forced = 'full'; h = h.replace(/^full=/i, ''); }
  setView(forced || LS.get('view', 'simple'));
  await detectLocalRelay(); refreshSettingsUI();
  if (h) { input.value = h.replace(/,/g, ', '); locate(h, { fromUser: false }); }
  else input.focus();
}
document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', init) : init();

/* expose pure functions for tests */
window.TailLocator = { verify, canonicalReg, parseInput, nearestAirports, decide, aptByCodes, hav, regVariants, normCallsign, parseTrace, legsFromPoints, utcDayPath, state, formatLine, airportLine, countryName };
})();
