// Functional tests v2: free path through the real Python relay (page + /ping served by tail_locator.py,
// upstream calls mocked at the browser), FR24 optional path, trace parsing and leg reconstruction.
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs'); const path = require('path');
const DIST = path.resolve(__dirname, '../dist');
const FILE = 'file://' + path.join(DIST, 'Tail-Locator.html');
const LEAFLET_JS = fs.readFileSync(path.resolve(__dirname, '../node_modules/leaflet/dist/leaflet.js'), 'utf8');
const LEAFLET_CSS = fs.readFileSync(path.resolve(__dirname, '../node_modules/leaflet/dist/leaflet.css'), 'utf8');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const nowIso = (offsetS = 0) => new Date(Date.now() + offsetS * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
let failures = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); if (!cond) failures++; };
const PORT = 8799;

function startRelay() {
  return new Promise((resolve, reject) => {
    const p = spawn('python3', [path.join(DIST, 'tail_locator.py'), '--port', String(PORT), '--no-browser'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; p.stdout.on('data', d => { out += d; if (/page:/.test(out)) resolve(p); }); p.stderr.on('data', d => { out += d; });
    p.on('exit', (c) => reject(new Error('relay exited ' + c + ' ' + out)));
    setTimeout(() => resolve(p), 2500);
  });
}
async function setup(scenario, url = FILE) {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const calls = [];
  await page.route('**/*', async (route) => {
    const u = route.request().url();
    if (u.startsWith('file://')) return route.continue();
    if (u.startsWith(`http://127.0.0.1:${PORT}/`) && !u.includes('/relay')) return route.continue(); // real python server: page + /ping
    if (u.includes('leaflet.min.js')) return route.fulfill({ status: 200, contentType: 'application/javascript', body: LEAFLET_JS });
    if (u.includes('leaflet.min.css')) return route.fulfill({ status: 200, contentType: 'text/css', body: LEAFLET_CSS });
    if (u.includes('fonts.g')) return route.abort();
    if (u.includes('cartocdn.com') || u.includes('plnspttrs')) return route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
    let target = u;
    if (u.includes('/relay?url=')) target = decodeURIComponent(u.split('url=')[1]);
    calls.push(target);
    const res = scenario(target, u);
    if (res === undefined) return route.fulfill({ status: 404, contentType: 'application/json', body: '{"message":"not found"}' });
    if (typeof res === 'string') return route.fulfill({ status: 200, contentType: 'text/plain', body: res });
    return route.fulfill({ status: res.status || 200, contentType: 'application/json', body: JSON.stringify(res.body !== undefined ? res.body : res) });
  });
  page.on('pageerror', e => { console.log('PAGEERROR', e.message); failures++; });
  page.on('console', m => { if (m.type() === 'error' && !/net::|Failed to load resource/.test(m.text())) console.log('CONSOLE', m.text()); });
  await page.goto(url);
  return { browser, page, calls };
}
const identityFor = (reg, hex, type, op) => ({ response: { aircraft: { type: type + ' 214', icao_type: type, manufacturer: 'Airbus', mode_s: hex, registration: reg, registered_owner_country_iso_name: 'IE', registered_owner_country_name: 'Ireland', registered_owner_operator_flag_code: 'EIN', registered_owner: op, url_photo: '', url_photo_thumbnail: '' } } });
const DUB = { lat: 53.4264, lon: -6.2499 }, SNN = { lat: 52.7011, lon: -8.9180 }, TEV = { lat: 40.4120, lon: -1.2160 };
// synthesize a readsb trace_full: ground at A, climb, cruise, descend, ground at B; endOffsetS = seconds ago the trace ends
function makeTrace(hex, reg, type, A, B, callsign, endAgoS, opts = {}) {
  const endT = Math.floor(Date.now() / 1000) - endAgoS; const dur = 3600; const startT = endT - dur - 1200; const base = startT;
  const pts = [];
  const push = (t, lat, lon, alt, gs, trk, flags, vr, ac) => pts.push([t - base, +lat.toFixed(5), +lon.toFixed(5), alt, gs, trk, flags, vr, ac || null, 'adsb_icao', alt === 'ground' ? null : alt, null, null]);
  for (let s = 0; s < 600; s += 60) push(startT + s, A.lat, A.lon, 'ground', 0, 90, 0, 0, s === 0 ? { flight: callsign, squawk: '1234', type } : null);
  const n = 60;
  for (let i = 1; i <= n; i++) { const f = i / n; const lat = A.lat + (B.lat - A.lat) * f, lon = A.lon + (B.lon - A.lon) * f; const alt = Math.round(36000 * Math.sin(Math.PI * f)); push(startT + 600 + i * (dur / n), lat, lon, Math.max(alt, 500), 420, 240, i === 1 ? 2 : 0, f < .5 ? 2000 : -1800, i === 2 ? { flight: callsign } : null); }
  if (!opts.lostAirborne) for (let s = 0; s < 600; s += 60) push(startT + 600 + dur + s, B.lat, B.lon, 'ground', 0, 240, 0, 0, null);
  return { icao: hex.toLowerCase(), r: reg, t: type, dbFlags: 0, desc: 'AIRBUS A-320', timestamp: base, trace: pts };
}

(async () => {
  const relay = await startRelay();
  try {
    // ---------- Python relay itself ----------
    {
      const ping = await (await fetch(`http://127.0.0.1:${PORT}/ping`)).json();
      check('relay: /ping answers local', ping.relay === 'local', JSON.stringify(ping));
      const html = await (await fetch(`http://127.0.0.1:${PORT}/`)).text();
      check('relay: serves the page', /<title>Tail Locator<\/title>/.test(html) && html.length > 800000, String(html.length));
      const r400 = await fetch(`http://127.0.0.1:${PORT}/relay`); check('relay: 400 without url', r400.status === 400);
      const r403 = await fetch(`http://127.0.0.1:${PORT}/relay?url=` + encodeURIComponent('https://evil.example/x')); check('relay: 403 for host outside allowlist', r403.status === 403);
      const r403b = await fetch(`http://127.0.0.1:${PORT}/relay?url=` + encodeURIComponent('http://api.adsb.lol/v2/hex/4CA281')); check('relay: 403 for plain http', r403b.status === 403);
      const rUp = await fetch(`http://127.0.0.1:${PORT}/relay?url=` + encodeURIComponent('https://api.adsb.lol/v2/hex/4CA281')); const j = await rUp.json().catch(() => null);
      check('relay: allowed host proxied (200 live or 502 JSON when offline here)', (rUp.status === 200 && j && Array.isArray(j.ac)) || (rUp.status === 502 && j && j.error), `${rUp.status} ${JSON.stringify(j).slice(0, 80)}`);
      check('relay: CORS header present', rUp.headers.get('access-control-allow-origin') === '*');
    }

    // ---------- pure functions: trace parsing + legs ----------
    {
      const { browser, page } = await setup(() => undefined);
      const tr = makeTrace('4CA281', 'EI-DEI', 'A320', DUB, SNN, 'EIN123', 4 * 3600);
      const r = await page.evaluate((trace) => {
        const T = window.TailLocator; const p = T.parseTrace(trace); const legs = T.legsFromPoints(p.pts);
        return { n: p.pts.length, hex: p.hex, reg: p.reg, legs: legs.map(l => ({ how: l.how, cs: l.callsign, dep: l.depApt && l.depApt.iata, depIn: l.depInside, arr: l.arrApt && l.arrApt.iata, arrIn: l.arrInside, maxAlt: l.maxAlt })), day: T.utcDayPath(new Date(Date.UTC(2026, 9, 4))) };
      }, tr);
      check('trace parsed', r.n === tr.trace.length && r.hex === '4CA281' && r.reg === 'EI-DEI', JSON.stringify([r.n, r.hex, r.reg]));
      check('one leg DUB→SNN landed, callsign carried', r.legs.length === 1 && r.legs[0].how === 'landed' && r.legs[0].dep === 'DUB' && r.legs[0].arr === 'SNN' && r.legs[0].depIn && r.legs[0].arrIn && r.legs[0].cs === 'EIN123', JSON.stringify(r.legs));
      check('utcDayPath', r.day === '2026/10/04', r.day);
      const lost = makeTrace('4CA281', 'EI-DEI', 'A320', DUB, { lat: 50.0, lon: -20.0 }, 'EIN105', 3 * 3600, { lostAirborne: true });
      const r2 = await page.evaluate((trace) => { const T = window.TailLocator; const legs = T.legsFromPoints(T.parseTrace(trace).pts); return legs.map(l => l.how); }, lost);
      check('airborne-ending trace → in-progress leg', JSON.stringify(r2) === JSON.stringify(['inprogress']), JSON.stringify(r2));
      await browser.close();
    }

    // ---------- H: free path via real local relay — parked at SNN 4 h, transponder off ----------
    {
      const trace = makeTrace('4CA281', 'EI-DEI', 'A320', DUB, SNN, 'EIN123', 4 * 3600);
      const { browser, page, calls } = await setup((t) => {
        if (t.includes('adsbdb.com/v0/aircraft/EI-DEI')) return identityFor('EI-DEI', '4CA281', 'A320', 'Aer Lingus');
        if (t.includes('adsbdb.com/v0/callsign/EIN123')) return { response: { flightroute: { callsign: 'EIN123', origin: { iata_code: 'DUB', icao_code: 'EIDW' }, destination: { iata_code: 'SNN', icao_code: 'EINN' }, airline: { name: 'Aer Lingus' } } } };
        if (t.includes('planespotters')) return { photos: [{ id: '1', thumbnail_large: { src: 'https://t.plnspttrs.net/x.jpg' }, link: 'https://www.planespotters.net/photo/1', photographer: 'Test' }] };
        if (/api\.adsb\.lol\/v2\/(reg|hex)/.test(t) || /airplanes\.live\/v2/.test(t) || /adsb\.fi\/api\/v2/.test(t)) return { ac: [], total: 0, now: Date.now() };
        if (t.includes('opensky-network.org/api/states/all')) return { time: Math.floor(Date.now() / 1000), states: null };
        if (t.includes('globe.adsb.lol/data/traces/81/trace_full_4ca281.json')) return trace;
        if (t.includes('globe_history')) return undefined; // 404 for context day
      }, `http://127.0.0.1:${PORT}/`);
      await page.evaluate(() => { localStorage.removeItem('avtl.fr24Key'); localStorage.removeItem('avtl.relay'); });
      await page.reload(); await page.waitForFunction(() => window.TailLocator && window.TailLocator.state.localRelay, null, { timeout: 8000 });
      const dot = await page.evaluate(() => document.getElementById('dotRelay').textContent + '|' + document.getElementById('dotRelay').className);
      check('H: local relay auto-detected', /Local relay\|dot on/.test(dot), dot);
      await page.fill('#regInput', 'EI-DEI'); await page.press('#regInput', 'Enter');
      await page.waitForSelector('.card .iata', { state: 'attached', timeout: 40000 }); await page.waitForFunction(() => !document.getElementById('progress').classList.contains('on'), null, { timeout: 40000 });
      const t = await page.evaluate(() => ({ iata: document.querySelector('#results .iata').textContent.trim(), status: document.querySelector('#results .status').textContent.trim(), cls: document.querySelector('#results .status').className, conf: document.querySelector('#results .conf').textContent, evidence: [...document.querySelectorAll('#results .evidence li')].map(l => l.textContent), rows: [...document.querySelectorAll('.legs tbody tr')].map(r => r.textContent.replace(/\s+/g, ' ').trim()), eyebrow: [...document.querySelectorAll('.eyebrow')].map(e => e.textContent), trail: document.querySelectorAll('.leaflet-overlay-pane path').length, flags: [...document.querySelectorAll('#results .verdict .flag')].map(f => f.textContent) }));
      check('H: IATA SNN from trace last point', t.iata === 'SNN', t.iata);
      check('H: status "On ground · since …" (ground class)', /^On ground · since/.test(t.status) && /ground/.test(t.cls), t.status);
      check('H: high confidence via adsb.lol trace', /High confidence · via adsb\.lol trace/.test(t.conf), t.conf);
      check('H: movements table DUB → SNN landed', t.rows.length === 1 && /EIN123/.test(t.rows[0]) && /DUB → SNN/.test(t.rows[0]) && /landed/.test(t.rows[0]), JSON.stringify(t.rows));
      check('H: movements eyebrow names adsb.lol traces', t.eyebrow.some(e => /Movements · adsb\.lol traces · recent/.test(e)), t.eyebrow.join('|'));
      check('H: trail + boundary drawn on map', t.trail >= 2, String(t.trail));
      check('H: no diversion flag (landed at usual destination)', !t.flags.some(f => /diversion/i.test(f)), t.flags.join('|'));
      const order = calls.filter(c => /adsb\.lol|airplanes|adsb\.fi|opensky/.test(c)).map(c => c.replace(/^https:\/\//, '').slice(0, 45));
      check('H: relay used for aggregators, OpenSky, then trace', order.some(c => c.startsWith('api.adsb.lol/v2/reg/EI-DEI,EIDEI')) && order.some(c => c.startsWith('opensky-network.org')) && order.some(c => c.startsWith('globe.adsb.lol/data/traces')), order.join(' ; '));
      const simple = await page.evaluate(() => ({ view: document.body.className, line: document.querySelector('#simple input.line') && document.querySelector('#simple input.line').value, status: document.querySelector('#simple .status') && document.querySelector('#simple .status').textContent, snippet: document.getElementById('siteSnippet').textContent, hash: location.hash, fullHidden: getComputedStyle(document.getElementById('results')).display }));
      check('H: Lookup view is default and hides full results', /view-simple/.test(simple.view) && simple.fullHidden === 'none', simple.view + ' ' + simple.fullHidden);
      check('H: website line exact format', simple.line === 'SNN - Shannon Airport - Ireland', simple.line);
      const vchk = await page.evaluate(() => ({ badge: document.querySelector('#simple .badge-lg').textContent, checks: [...document.querySelectorAll('#simple .checks li')].map(l => l.className) }));
      check('H: VERIFIED badge, all checks pass', vchk.badge === 'VERIFIED' && vchk.checks.length >= 6 && vchk.checks.every(c => c === 'ok'), JSON.stringify(vchk));
      check('H: hash carries simple= prefix', simple.hash === '#simple=EI-DEI', simple.hash);
      check('H: snippet renders a real closing script tag', /<\/script>$/.test(simple.snippet.trim()) && /127\.0\.0\.1:8765\/locate/.test(simple.snippet), simple.snippet.slice(-40));
      await page.screenshot({ path: path.resolve(__dirname, 'shot-H-simple.png'), fullPage: true });
      await page.click('#tabFull'); await page.waitForTimeout(200);
      await page.click('#tabDev'); const dev = await page.evaluate(() => ({ visible: getComputedStyle(document.querySelector('.v-dev')).display !== 'none', rows: document.querySelectorAll('.v-dev table tbody tr').length })); check('Developer tab shows source and check tables', dev.visible && dev.rows >= 20, JSON.stringify(dev)); await page.screenshot({ path: path.resolve(__dirname, 'shot-dev.png'), fullPage: true }); await page.click('#tabFull'); await page.waitForTimeout(100);
      const full = await page.evaluate(() => ({ view: document.body.className, cards: document.querySelectorAll('#results .card').length, simpleHidden: getComputedStyle(document.getElementById('simpleCard')).display }));
      check('H: Full tab shows cards and hides simple block', /view-full/.test(full.view) && full.cards === 1 && full.simpleHidden === 'none', JSON.stringify(full));
      await page.screenshot({ path: path.resolve(__dirname, 'shot-H.png'), fullPage: true });
      await browser.close();
    }

    // ---------- H2: airborne via relay (adsb.lol live), usual route DUB→LHR, departure from trace; parent frame receives postMessage ----------
    {
      const lostTrace = makeTrace('4CA281', 'EI-DEI', 'A320', DUB, { lat: 53.1, lon: -4.6 }, 'EIN123', 10, { lostAirborne: true });
      const { browser, page } = await setup((t, u) => {
        if (u.endsWith('/parent-test')) return undefined;
        if (t.includes('adsbdb.com/v0/aircraft/EI-DEI')) return identityFor('EI-DEI', '4CA281', 'A320', 'Aer Lingus');
        if (t.includes('adsbdb.com/v0/callsign/EIN123')) return { response: { flightroute: { callsign: 'EIN123', origin: { iata_code: 'DUB', icao_code: 'EIDW' }, destination: { iata_code: 'LHR', icao_code: 'EGLL' }, airline: { name: 'Aer Lingus' } } } };
        if (t.includes('planespotters')) return { photos: [] };
        if (/api\.adsb\.lol\/v2\/reg/.test(t)) return { ac: [{ hex: '4ca281', r: 'EI-DEI', t: 'A320', flight: 'EIN123 ', alt_baro: 36000, gs: 450, track: 110, baro_rate: 0, squawk: '5531', lat: 53.1, lon: -4.6, seen_pos: 3, seen: 1, type: 'adsb_icao' }], total: 1, now: Date.now() };
        if (t.includes('globe.adsb.lol/data/traces/81/trace_full_4ca281.json')) return lostTrace;
        if (t.includes('globe_history')) return undefined;
        return { ac: [], now: Date.now() };
      }, `http://127.0.0.1:${PORT}/`);
      // parent page embedding the tool in an iframe with #simple=EI-DEI
      await page.route(`http://127.0.0.1:${PORT}/parent-test`, r => r.fulfill({ status: 200, contentType: 'text/html', body: `<!doctype html><html><body><input id="box"><iframe id="f" src="http://127.0.0.1:${PORT}/#simple=EI-DEI" width="900" height="600"></iframe><script>window.__msgs=[];addEventListener('message',e=>{window.__msgs.push(e.data);if(e.data&&e.data.type==='tail-locator')document.getElementById('box').value=e.data.results[0].text;});</script></body></html>` }));
      await page.goto(`http://127.0.0.1:${PORT}/parent-test`);
      await page.waitForFunction(() => document.getElementById('box').value.length > 0, null, { timeout: 60000 });
      const t = await page.evaluate(() => ({ box: document.getElementById('box').value, msg: window.__msgs.find(m => m && m.type === 'tail-locator') }));
      check('H2: en route line exact format', t.box === 'Currently en route to LHR - London Heathrow Airport - United Kingdom from DUB - Dublin Airport - Ireland', t.box);
      check('H2: postMessage payload has status enroute + verified', t.msg && t.msg.results[0].status === 'enroute' && t.msg.results[0].reg === 'EI-DEI' && t.msg.results[0].verified === true, JSON.stringify(t.msg).slice(0, 300));
      const frame = page.frames().find(f => f.url().includes('#simple=EI-DEI'));
      const inner = await frame.evaluate(() => ({ line: document.querySelector('#simple input.line').value, status: [...document.querySelectorAll('#simple .status, #simple .badge-lg')].map(s => s.textContent).join('|') }));
      check('H2: iframe shows In flight', /In flight/.test(inner.status) && inner.line === t.box, inner.status);
      await browser.close();
    }

    // ---------- H3: single live ground fix, nothing to corroborate → fail closed ----------
    {
      const { browser, page } = await setup((t) => {
        if (t.includes('adsbdb.com/v0/aircraft/EI-DEI')) return identityFor('EI-DEI', '4CA281', 'A320', 'Aer Lingus');
        if (t.includes('planespotters')) return { photos: [] };
        if (/api\.adsb\.lol\/v2\/reg/.test(t)) return { ac: [{ hex: '4ca281', r: 'EI-DEI', t: 'A320', alt_baro: 'ground', gs: 0, lat: SNN.lat, lon: SNN.lon, seen_pos: 4, type: 'adsb_icao' }], total: 1, now: Date.now() };
        if (/airplanes\.live|adsb\.fi/.test(t)) return { ac: [], now: Date.now() };
        if (t.includes('opensky')) return { time: 1, states: null };
        return undefined; // no traces
      }, `http://127.0.0.1:${PORT}/`);
      await page.evaluate(() => { localStorage.removeItem('avtl.fr24Key'); });
      await page.reload(); await page.waitForFunction(() => window.TailLocator && window.TailLocator.state.localRelay, null, { timeout: 8000 });
      await page.fill('#regInput', 'EI-DEI'); await page.press('#regInput', 'Enter');
      await page.waitForSelector('#simple input.line', { state: 'attached', timeout: 60000 }); await page.waitForFunction(() => !document.getElementById('progress').classList.contains('on'), null, { timeout: 60000 });
      const t = await page.evaluate(() => ({ line: document.querySelector('#simple input.line').value, badge: document.querySelector('#simple .badge-lg').textContent, guess: (document.querySelector('#simple .sumsec p.mono') || {}).textContent, failed: [...document.querySelectorAll('#simple .checks li.bad')].map(l => l.children[1].textContent) }));
      check('H3: uncorroborated single fix → UNVERIFIED line', t.badge === 'UNVERIFIED' && /^UNVERIFIED - manual check required - Corroborated:/.test(t.line), t.line);
      check('H3: best guess shown separately, only Corroborated failed', t.guess === 'SNN - Shannon Airport - Ireland' && JSON.stringify(t.failed) === JSON.stringify(['Corroborated']), JSON.stringify([t.guess, t.failed]));
      await page.screenshot({ path: path.resolve(__dirname, 'shot-H3.png'), fullPage: true });
      await browser.close();
    }

    // ---------- /locate endpoint on the real server (offline here → honest "no data" answer, still valid JSON) ----------
    {
      const r = await fetch(`http://127.0.0.1:${PORT}/locate?reg=ZZ-TEST&days=1`); const j = await r.json();
      check('locate endpoint: JSON shape', r.status === 200 && j.ok === true && j.reg === 'ZZ-TEST' && typeof j.text === 'string' && Array.isArray(j.results) && j.results[0].log.length > 0, JSON.stringify(j).slice(0, 160));
      check('locate endpoint: text for unknown fails closed', /^UNVERIFIED - manual check required - no position data for ZZ-TEST in the last 1 days$/.test(j.text) && j.verified === false, j.text);
      const r2 = await fetch(`http://127.0.0.1:${PORT}/locate?reg=ZZ-TEST&days=1&format=text`); const txt = await r2.text();
      check('locate endpoint: format=text returns bare line', r2.headers.get('content-type').startsWith('text/plain') && txt.trim() === j.text, txt);
      const r3 = await fetch(`http://127.0.0.1:${PORT}/locate`); check('locate endpoint: 400 without reg', r3.status === 400);
      const opt = await fetch(`http://127.0.0.1:${PORT}/locate?reg=X`, { method: 'OPTIONS' }); check('locate endpoint: preflight allows private network', opt.status === 204 && opt.headers.get('access-control-allow-private-network') === 'true');
    }

    // ---------- I: nothing live, no recent trace, found 2 days back at Teruel; usual route says somewhere else → diversion flag ----------
    {
      const two = new Date(Date.now() - 2 * 86400000); const p = (n) => String(n).padStart(2, '0'); const dayPath = `${two.getUTCFullYear()}/${p(two.getUTCMonth() + 1)}/${p(two.getUTCDate())}`;
      const trace = makeTrace('345123', 'EC-MQM', 'A332', { lat: 40.4722, lon: -3.5608 }, TEV, 'IBE9999', 2 * 86400 + 3600);
      const { browser, page, calls } = await setup((t) => {
        if (t.includes('adsbdb.com/v0/aircraft/EC-MQM')) return identityFor('EC-MQM', '345123', 'A332', 'Iberia');
        if (t.includes('adsbdb.com/v0/callsign/IBE9999')) return { response: { flightroute: { callsign: 'IBE9999', origin: { iata_code: 'MAD', icao_code: 'LEMD' }, destination: { iata_code: 'BCN', icao_code: 'LEBL' }, airline: { name: 'Iberia' } } } };
        if (t.includes('planespotters')) return { photos: [] };
        if (/api\.adsb\.lol\/v2\/(reg|hex)/.test(t) || /airplanes\.live\/v2/.test(t) || /adsb\.fi\/api\/v2/.test(t)) return { ac: [], total: 0, now: Date.now() };
        if (t.includes('opensky-network.org')) return { time: 1, states: null };
        if (t.includes(`globe_history/${dayPath}/traces/23/trace_full_345123.json`)) return trace;
        return undefined;
      }, `http://127.0.0.1:${PORT}/`);
      await page.evaluate(() => { localStorage.removeItem('avtl.fr24Key'); localStorage.setItem('avtl.lookback', '7'); });
      await page.reload(); await page.waitForFunction(() => window.TailLocator && window.TailLocator.state.localRelay, null, { timeout: 8000 });
      await page.fill('#regInput', 'ECMQM'); await page.press('#regInput', 'Enter');
      await page.waitForSelector('.card .iata', { state: 'attached', timeout: 60000 }); await page.waitForFunction(() => !document.getElementById('progress').classList.contains('on'), null, { timeout: 60000 });
      const t = await page.evaluate(() => ({ iata: document.querySelector('#results .iata').textContent.trim(), status: document.querySelector('#results .status').textContent.trim(), flags: [...document.querySelectorAll('#results .verdict .flag')].map(f => f.textContent), conf: document.querySelector('#results .conf').textContent, rows: [...document.querySelectorAll('.legs tbody tr')].map(r => r.textContent.replace(/\s+/g, ' ').trim()), log: [...document.querySelectorAll('#results .evidence.note li')].map(l => l.textContent), evidence: [...document.querySelectorAll('#results .evidence li')].map(l => l.textContent) }));
      check('I: IATA TEV from 2-day-old archive trace', t.iata === 'TEV', t.iata);
      check('I: On ground · since (2 days, still high)', /^On ground · since/.test(t.status) && /High/.test(t.conf), `${t.status} / ${t.conf}`);
      check('I: usual-route mismatch is NOT flagged as a diversion', !t.flags.some(f => /diversion/i.test(f)) && t.evidence.some(e => /Route database lists callsign IBE9999/.test(e) && /not treated as a diversion/.test(e)), t.flags.join('|') + ' / ' + t.evidence.join(' | '));
      check('I: movements row notes the usual route neutrally', t.rows.some(r => /landed \(usual route BCN\)/.test(r)), JSON.stringify(t.rows));
      const iline = await page.evaluate(() => ({ line: document.querySelector('#simple input.line').value, badge: document.querySelector('#simple .badge-lg').textContent }));
      check('I: verified by trace dwell (position is what counts)', iline.badge === 'VERIFIED' && iline.line === 'TEV - Teruel Airport - Spain', JSON.stringify(iline));
      const traceCalls = calls.filter(c => c.includes('trace_full_345123'));
      check('I: walked recent → day-1 → day-2 (+ context day)', traceCalls.length === 4 && traceCalls[0].includes('/data/traces/') && traceCalls[2].includes(dayPath), traceCalls.map(c => c.replace(/.*adsb\.lol\//, '')).join(' ; '));
      await browser.close();
    }

    // ---------- J: no relay, no key (file opened directly) — identity only, clear guidance ----------
    {
      const { browser, page } = await setup((t) => {
        if (t.includes('adsbdb.com/v0/aircraft/EI-DEI')) return identityFor('EI-DEI', '4CA281', 'A320', 'Aer Lingus');
        if (t.includes('planespotters')) return { photos: [] };
      });
      await page.evaluate(() => { localStorage.removeItem('avtl.fr24Key'); localStorage.removeItem('avtl.relay'); });
      await page.reload(); await page.fill('#regInput', 'EI-DEI'); await page.press('#regInput', 'Enter');
      await page.waitForSelector('.card .iata', { state: 'attached', timeout: 20000 }); await page.waitForFunction(() => !document.getElementById('progress').classList.contains('on'));
      const t = await page.evaluate(() => ({ status: document.querySelector('#results .status').textContent.trim(), hint: document.getElementById('hintText').textContent, log: [...document.querySelectorAll('#results .evidence.note li')].map(l => l.textContent), local: document.getElementById('localState').textContent }));
      check('J: no relay → No position data with guidance', /No position data/.test(t.status) && t.log.some(l => /start tail_locator\.py/.test(l)), t.log.join('|'));
      check('J: hint tells how to get positions', /tail_locator\.py/.test(t.hint), t.hint);
      check('J: local relay state explains file:// case', /opened the HTML file directly/.test(t.local), t.local);
      await browser.close();
    }

    // ---------- K: FR24 optional path still works (live on ground + history, no relay) ----------
    {
      const { browser, page } = await setup((t) => {
        if (t.includes('adsbdb.com/v0/aircraft/EI-DEO')) return identityFor('EI-DEO', '4CA2A2', 'A320', 'Aer Lingus');
        if (t.includes('planespotters')) return { photos: [] };
        if (t.includes('/live/flight-positions/full')) return { data: [] };
        if (t.includes('/flight-summary/full')) return { data: [{ fr24_id: '2', flight: 'EI517', callsign: 'EIN517', type: 'A320', reg: 'EI-DEO', orig_icao: 'LFPG', orig_iata: 'CDG', datetime_takeoff: nowIso(-5 * 3600), dest_icao: 'EIDW', dest_iata: 'DUB', dest_icao_actual: 'EINN', dest_iata_actual: 'SNN', datetime_landed: nowIso(-3 * 3600), runway_landed: '24', hex: '4CA2A2', first_seen: nowIso(-5.1 * 3600), last_seen: nowIso(-2.9 * 3600), flight_ended: true }] };
      });
      await page.evaluate(() => { localStorage.setItem('avtl.fr24Key', JSON.stringify('TESTKEY')); localStorage.removeItem('avtl.relay'); });
      await page.reload(); await page.fill('#regInput', 'EI-DEO'); await page.press('#regInput', 'Enter');
      await page.waitForSelector('.card .iata', { state: 'attached', timeout: 20000 }); await page.waitForFunction(() => !document.getElementById('progress').classList.contains('on'));
      const t = await page.evaluate(() => ({ iata: document.querySelector('#results .iata').textContent.trim(), status: document.querySelector('#results .status').textContent.trim(), flags: [...document.querySelectorAll('#results .verdict .flag')].map(f => f.textContent) }));
      check('K: FR24-only path: SNN, on ground since, DIVERTED, verified by landing record', t.iata === 'SNN' && /On ground · since/.test(t.status) && t.flags.some(f => /DIVERTED/.test(f)) && t.flags.includes('verified'), `${t.iata} ${t.status} ${t.flags.join('|')}`);
      await browser.close();
    }

    // ---------- L: FR24 live airborne + divert watch (regression of earlier C/D) ----------
    {
      const { browser, page } = await setup((t) => {
        if (t.includes('adsbdb.com')) return identityFor('EI-DEI', '4CA281', 'A320', 'Aer Lingus');
        if (t.includes('planespotters')) return { photos: [] };
        if (t.includes('/live/flight-positions/full')) return { data: [{ fr24_id: '4', flight: 'EI123', callsign: 'EIN123', lat: 52.78, lon: -8.60, track: 245, alt: 4500, gspeed: 210, vspeed: -1100, squawk: '2000', timestamp: nowIso(-5), source: 'ADSB', hex: '4CA281', type: 'A320', reg: 'EI-DEI', orig_iata: 'LHR', orig_icao: 'EGLL', dest_iata: 'DUB', dest_icao: 'EIDW', eta: null }] };
        if (t.includes('/flight-summary/full')) return { data: [] };
      });
      await page.evaluate(() => { localStorage.setItem('avtl.fr24Key', JSON.stringify('TESTKEY')); });
      await page.reload(); await page.fill('#regInput', 'EI-DEI'); await page.press('#regInput', 'Enter');
      await page.waitForSelector('.card .iata', { state: 'attached', timeout: 20000 }); await page.waitForFunction(() => !document.getElementById('progress').classList.contains('on'));
      const t = await page.evaluate(() => ({ iata: document.querySelector('#results .iata').textContent.trim(), flags: [...document.querySelectorAll('#results .verdict .flag')].map(f => f.textContent), status: document.querySelector('#results .status').textContent }));
      check('L: possible diversion → line fails closed', t.iata === 'DUB' && /In flight/.test(t.status) && t.flags.some(f => /toward SNN/.test(f)) && t.flags.some(f => /^UNVERIFIED/.test(f) && /diversion/.test(f)), `${t.iata} ${t.flags.join('|')}`);
      await browser.close();
    }
  } finally { relay.kill(); }
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
