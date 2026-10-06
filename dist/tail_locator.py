#!/usr/bin/env python3
"""
Tail Locator — local launcher + lookup engine (free, no keys, no accounts).

What it does
  1. Serves Tail-Locator.html (same folder) and relays its API calls to the free
     ADS-B services, which refuse direct browser calls: adsb.lol, airplanes.live, adsb.fi,
     OpenSky, plus the adsb.lol per-aircraft trace archive used for history.
  2. Answers http://127.0.0.1:8765/locate?reg=EI-DEI with JSON, including the one-line text
       "SNN - Shannon Airport - Ireland"
       "Currently en route to LHR - London Heathrow Airport - United Kingdom from DUB - Dublin Airport - Ireland"
     so another website or script can fill a text box without the page.
  3. Same answer from the command line:  python tail_locator.py locate EI-DEI G-XWBA
     and from Python:                      import tail_locator; tail_locator.locate_text("EI-DEI")

Run:   python tail_locator.py            (or double-click Start-Tail-Locator.bat)
Stop:  Ctrl+C
Options: --port 8765   --no-browser   --days 7

Python 3.8+ standard library only. Needs airports.json (or the HTML file, which embeds the same data)
in the same folder. Personal, non-commercial use of the community ADS-B feeds — consider feeding a receiver.
"""
import argparse
import gzip
import http.server
import json
import math
import os
import re
import socket
import socketserver
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
import zlib
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
HTML_FILE = os.path.join(HERE, "Tail-Locator.html")
DATA_FILE = os.path.join(HERE, "airports.json")
UA = "Tail-Locator/2.1 (personal, non-commercial; local relay)"
TIMEOUT = 25
FRESH_S = 15 * 60
ALLOW = {
    "api.adsb.lol", "globe.adsb.lol", "adsb.lol",
    "api.airplanes.live", "opendata.adsb.fi", "api.adsb.one", "opensky-network.org",
    "api.adsbdb.com", "hexdb.io", "vrs-standing-data.adsb.lol", "api.planespotters.net",
}
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

# ----------------------------------------------------------------------------- data
_AIRPORTS = None
_COUNTRIES = None


def _load_data():
    global _AIRPORTS, _COUNTRIES
    if _AIRPORTS is not None:
        return
    raw = None
    if os.path.exists(DATA_FILE):
        with open(DATA_FILE, encoding="utf-8") as f:
            raw = json.load(f)
    elif os.path.exists(HTML_FILE):
        with open(HTML_FILE, encoding="utf-8") as f:
            html = f.read()
        m = re.search(r"window\.AIRPORTS=(\[.*?\]);</script>", html, re.S)
        c = re.search(r"window\.COUNTRIES=(\{.*?\});</script>", html, re.S)
        raw = {"airports": json.loads(m.group(1)) if m else [], "countries": json.loads(c.group(1)) if c else {}}
    if not raw:
        raise SystemExit("airports.json (or the HTML file) must sit next to tail_locator.py")
    _AIRPORTS = [dict(code=r[0] or "", iata=r[1] or "", lat=r[2], lon=r[3], name=r[4], city=r[5] or "", country=r[6] or "", size=r[7], radius=r[8], elev=r[9]) for r in raw["airports"]]
    _COUNTRIES = raw.get("countries", {})


def airports():
    _load_data()
    return _AIRPORTS


def country_name(code):
    _load_data()
    return _COUNTRIES.get(code, code)


def hav(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lon2 - lon1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * 6371.0088 * math.asin(min(1.0, math.sqrt(h)))


SIZE_RANK = {"L": 3, "M": 2, "S": 1, "W": 0}


def nearest(lat, lon, n=3):
    cos_lat = max(0.2, math.cos(math.radians(lat)))
    out = []
    for a in airports():
        if abs(a["lat"] - lat) > 1.5:
            continue
        dlon = abs(a["lon"] - lon)
        if dlon > 180:
            dlon = 360 - dlon
        if dlon * cos_lat > 1.5:
            continue
        b = dict(a)
        b["dist"] = hav(lat, lon, a["lat"], a["lon"])
        out.append(b)
    out.sort(key=lambda x: x["dist"])
    if len(out) > 1 and out[0]["dist"] <= out[0]["radius"] and out[1]["dist"] <= out[1]["radius"] and SIZE_RANK.get(out[1]["size"], 0) > SIZE_RANK.get(out[0]["size"], 0):
        out[0], out[1] = out[1], out[0]
    return out[:n]


def airport_by_codes(iata="", icao=""):
    iata, icao = (iata or "").upper(), (icao or "").upper()
    best = None
    for a in airports():
        if iata and a["iata"] == iata:
            if best is None or SIZE_RANK.get(a["size"], 0) > SIZE_RANK.get(best["size"], 0):
                best = a
    if best:
        return best
    if icao:
        for a in airports():
            if a["code"] == icao:
                return a
    return None


def airport_line(a):
    """'SNN - Shannon Airport - Ireland' (ICAO used when the airport has no IATA code)."""
    if not a:
        return None
    code = a["iata"] or a["code"] or "????"
    return "%s - %s - %s" % (code, a["name"], country_name(a["country"]))


# ----------------------------------------------------------------------------- registrations
NOHYPH = ("JA", "HL", "UK")
PFX3 = ("9XR", "A40", "A9C", "T8A", "RDPL", "VPB", "VPC", "VQB", "VQT")
PFX2 = ("3A 3B 3C 3D 3X 4K 4L 4O 4R 4X 5A 5B 5H 5N 5R 5T 5U 5V 5W 5X 5Y 6O 6V 6Y 7O 7P 7Q 7T 8P 8Q 8R 9A 9G 9H 9J 9K 9L 9M 9N 9Q 9U 9V 9Y "
        "A2 A3 A5 A6 A7 AP C2 C3 C5 C6 C9 CC CN CP CS CU CX D2 D4 D6 DQ E3 E5 E7 EC EI EJ EK EP ER ES ET EW EX EY EZ H4 HA HB HC HH HI HK HP HR HS HZ "
        "J2 J3 J5 J6 J7 J8 JU JY LN LV LX LY LZ OB OD OE OH OK OM OO OY P2 P4 PH PJ PK PP PR PS PT PU PZ RA RP S2 S5 S7 S9 SE SP ST SU SX T2 T3 T7 T9 "
        "TC TF TG TI TJ TL TN TR TS TT TU TY TZ UN UP UR V2 V3 V4 V5 V6 V7 V8 VH VN VP VQ VT XA XB XC XT XU XY YA YI YJ YK YL YN YR YS YU YV Z3 ZA ZK ZL ZM ZP ZS ZT ZU").split()
PFX1 = ("B", "C", "D", "F", "G", "I", "M", "P", "Z", "2")


def canonical_reg(raw):
    s = re.sub(r"[^A-Z0-9-]", "", str(raw or "").upper())
    if not s:
        return ""
    if "-" in s:
        return re.sub(r"-+", "-", s).strip("-")
    if re.match(r"^N\d", s):
        return s
    for p in NOHYPH:
        if s.startswith(p):
            return s
    for p in PFX3:
        if s.startswith(p) and len(s) > len(p):
            return s[:2] + "-" + s[2:] if p[0] == "V" else p + "-" + s[len(p):]
    for p in PFX2:
        if s.startswith(p) and len(s) > 2:
            return p + "-" + s[2:]
    for p in PFX1:
        if s.startswith(p) and len(s) > 1:
            return p + "-" + s[1:]
    return s


def reg_variants(canon):
    bare = canon.replace("-", "")
    return [canon] if bare == canon else [canon, bare]


def reg_key(r):
    return re.sub(r"[^A-Z0-9]", "", str(r or "").upper())


def norm_callsign(cs):
    m = re.match(r"^([A-Z]{3})0*(\d+[A-Z]*)$", cs or "")
    return m.group(1) + m.group(2) if m else (cs or "")


# ----------------------------------------------------------------------------- http
def http_get(url, timeout=TIMEOUT):
    """Return (status, bytes, content_type). Never raises for HTTP errors; raises for transport errors."""
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json, */*;q=0.5", "Accept-Encoding": "gzip, deflate"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body, enc, ctype, status = r.read(), (r.headers.get("Content-Encoding") or "").lower(), r.headers.get("Content-Type") or "application/json", r.status
    except urllib.error.HTTPError as e:
        body = e.read() if hasattr(e, "read") else b""
        enc = (e.headers.get("Content-Encoding") or "").lower() if e.headers else ""
        ctype = (e.headers.get("Content-Type") if e.headers else None) or "application/json"
        status = e.code
    try:
        if enc == "gzip":
            body = gzip.decompress(body)
        elif enc == "deflate":
            body = zlib.decompress(body, -zlib.MAX_WBITS)
    except Exception:
        pass
    return status, body, ctype


def get_json(url, timeout=TIMEOUT):
    """Return parsed JSON or None (404, transport error, bad JSON)."""
    try:
        status, body, _ = http_get(url, timeout)
    except Exception:
        return None
    if status != 200:
        return None
    try:
        return json.loads(body.decode("utf-8", "replace"))
    except Exception:
        return None


# ----------------------------------------------------------------------------- sources
def identity(canon):
    for v in reg_variants(canon):
        j = get_json("https://api.adsbdb.com/v0/aircraft/" + urllib.parse.quote(v), 12)
        a = (j or {}).get("response", {}).get("aircraft") if isinstance(j, dict) and isinstance(j.get("response"), dict) else None
        if a:
            return {"hex": (a.get("mode_s") or "").upper(), "type": a.get("icao_type") or "", "operator": a.get("registered_owner") or "", "src": "adsbdb"}
    try:
        status, body, _ = http_get("https://hexdb.io/reg-hex?reg=" + urllib.parse.quote(canon), 10)
        hx = body.decode("ascii", "ignore").strip().upper()
        if status == 200 and re.match(r"^[0-9A-F]{6}$", hx):
            j = get_json("https://hexdb.io/api/v1/aircraft/" + hx, 10) or {}
            return {"hex": hx, "type": j.get("ICAOTypeCode") or "", "operator": j.get("RegisteredOwners") or "", "src": "hexdb"}
    except Exception:
        pass
    return None


def _fix_from_readsb(ac, now_ms, src):
    if not isinstance(ac.get("lat"), (int, float)) or not isinstance(ac.get("lon"), (int, float)):
        return None
    seen = ac.get("seen_pos") if isinstance(ac.get("seen_pos"), (int, float)) else (ac.get("seen") if isinstance(ac.get("seen"), (int, float)) else 0)
    alt = ac.get("alt_baro")
    if alt != "ground" and not isinstance(alt, (int, float)):
        alt = ac.get("alt_geom") if isinstance(ac.get("alt_geom"), (int, float)) else None
    vs = ac.get("baro_rate") if isinstance(ac.get("baro_rate"), (int, float)) else (ac.get("geom_rate") if isinstance(ac.get("geom_rate"), (int, float)) else None)
    return {"src": src, "t": now_ms / 1000.0 - seen, "lat": ac["lat"], "lon": ac["lon"], "alt": alt, "gs": ac.get("gs") if isinstance(ac.get("gs"), (int, float)) else None,
            "vs": vs, "track": ac.get("track") if isinstance(ac.get("track"), (int, float)) else None, "callsign": (ac.get("flight") or "").strip(), "hex": (ac.get("hex") or "").upper(), "reg": (ac.get("r") or "").strip(), "type": ac.get("t") or ""}


AGGREGATORS = (
    ("adsb.lol", "https://api.adsb.lol/v2/reg/{}", "https://api.adsb.lol/v2/hex/{}"),
    ("airplanes.live", "https://api.airplanes.live/v2/reg/{}", "https://api.airplanes.live/v2/hex/{}"),
    ("adsb.fi", "https://opendata.adsb.fi/api/v2/registration/{}", "https://opendata.adsb.fi/api/v2/hex/{}"),
)


def live_aggregators(canon, hx, log):
    """Query every aggregator (not just until the first hit) so independent sources can corroborate. Returns a list of fixes."""
    variants = reg_variants(canon)
    keys = {reg_key(v) for v in variants}
    fixes = []
    for name, reg_url, hex_url in AGGREGATORS:
        got = None
        j = get_json(reg_url.format(",".join(variants)), 15)
        if isinstance(j, dict):
            now_ms = j.get("now") if isinstance(j.get("now"), (int, float)) else time.time() * 1000
            for ac in j.get("ac") or []:
                if reg_key(ac.get("r")) in keys or (hx and (ac.get("hex") or "").upper() == hx):
                    got = _fix_from_readsb(ac, now_ms, name)
                    if got:
                        break
        if not got and hx:
            time.sleep(1.0)
            j = get_json(hex_url.format(hx.lower()), 15)
            if isinstance(j, dict):
                now_ms = j.get("now") if isinstance(j.get("now"), (int, float)) else time.time() * 1000
                for ac in j.get("ac") or []:
                    if (ac.get("hex") or "").upper() == hx:
                        got = _fix_from_readsb(ac, now_ms, name)
                        if got:
                            break
        if got:
            fixes.append(got)
            log.append("%s: live position" % name)
        else:
            log.append("%s: not transmitting" % name)
    return fixes


def live_opensky(hx, log):
    if not hx:
        return None
    j = get_json("https://opensky-network.org/api/states/all?icao24=" + hx.lower(), 20)
    if not isinstance(j, dict) or not j.get("states"):
        log.append("OpenSky: not transmitting")
        return None
    s = j["states"][0]
    if not isinstance(s[6], (int, float)) or not isinstance(s[5], (int, float)):
        return None
    log.append("OpenSky: live position")
    return {"src": "OpenSky", "t": float(s[3] or s[4] or j.get("time") or time.time()), "lat": s[6], "lon": s[5],
            "alt": "ground" if s[8] else (round(s[7] * 3.28084) if isinstance(s[7], (int, float)) else None),
            "gs": round(s[9] * 1.94384) if isinstance(s[9], (int, float)) else None, "vs": round(s[11] * 196.85) if isinstance(s[11], (int, float)) else None,
            "track": s[10] if isinstance(s[10], (int, float)) else None, "callsign": (s[1] or "").strip(), "hex": hx, "reg": "", "type": ""}


_TRACE_META = {}


def _parse_trace(j):
    if j.get("icao"):
        _TRACE_META[str(j["icao"]).lower()] = {"icao": str(j["icao"]).upper(), "r": j.get("r") or "", "t": j.get("t") or ""}
    base = float(j.get("timestamp") or 0)
    pts = []
    for p in j.get("trace") or []:
        if not isinstance(p, list) or len(p) < 4 or not isinstance(p[1], (int, float)) or not isinstance(p[2], (int, float)):
            continue
        ac = p[8] if len(p) > 8 and isinstance(p[8], dict) else None
        alt = "ground" if p[3] == "ground" else (p[3] if isinstance(p[3], (int, float)) else None)
        pts.append({"t": base + p[0], "lat": p[1], "lon": p[2], "alt": alt, "gs": p[4] if len(p) > 4 and isinstance(p[4], (int, float)) else None,
                    "vs": p[7] if len(p) > 7 and isinstance(p[7], (int, float)) else None, "callsign": (ac.get("flight") or "").strip() if ac else ""})
    return pts


def trace_points(hx, lookback, log):
    """adsb.lol traces: today's rolling file, then the daily archive back `lookback` days. Returns (points, labels)."""
    if not hx:
        return [], []
    hx = hx.lower()
    got, labels = [], []
    url = "https://globe.adsb.lol/data/traces/%s/trace_full_%s.json" % (hx[-2:], hx)
    j = get_json(url, 25)
    if isinstance(j, dict) and j.get("trace"):
        got += _parse_trace(j)
        labels.append("recent")
    day, today = 1, datetime.now(timezone.utc)
    while not got and day <= lookback:
        d = today - timedelta(days=day)
        j = get_json("https://globe.adsb.lol/globe_history/%s/traces/%s/trace_full_%s.json" % (d.strftime("%Y/%m/%d"), hx[-2:], hx), 25)
        if isinstance(j, dict) and j.get("trace"):
            got += _parse_trace(j)
            labels.append(d.strftime("%Y-%m-%d"))
        day += 1
    got.sort(key=lambda p: p["t"])
    log.append("adsb.lol traces: %d positions (%s)" % (len(got), ", ".join(labels)) if got else "adsb.lol traces: nothing in the last %d days" % lookback)
    return got, labels


def route_for(callsign, log):
    cs = norm_callsign((callsign or "").upper().strip())
    if not re.match(r"^[A-Z]{3}\d", cs):
        return None
    j = get_json("https://api.adsbdb.com/v0/callsign/" + cs, 10)
    fr = (j or {}).get("response", {}).get("flightroute") if isinstance(j, dict) and isinstance(j.get("response"), dict) else None
    if fr and fr.get("origin") and fr.get("destination"):
        log.append("route for %s: adsbdb" % cs)
        return {"orig": (fr["origin"].get("iata_code") or "", fr["origin"].get("icao_code") or ""), "dest": (fr["destination"].get("iata_code") or "", fr["destination"].get("icao_code") or ""), "src": "adsbdb"}
    j = get_json("https://hexdb.io/api/v1/route/icao/" + cs, 10)
    m = re.match(r"^([A-Z0-9]{3,4})-([A-Z0-9]{3,4})", (j or {}).get("route") or "") if isinstance(j, dict) else None
    if m:
        log.append("route for %s: hexdb" % cs)
        return {"orig": ("", m.group(1)), "dest": ("", m.group(2)), "src": "hexdb"}
    j = get_json("https://vrs-standing-data.adsb.lol/routes/%s/%s.json" % (cs[:2], cs), 10)
    m = re.match(r"^([A-Z0-9]{3,4})-([A-Z0-9]{3,4})", (j or {}).get("airport_codes") or "") if isinstance(j, dict) else None
    if m:
        log.append("route for %s: VRS" % cs)
        return {"orig": ("", m.group(1)), "dest": ("", m.group(2)), "src": "VRS"}
    log.append("route for %s: unknown" % cs)
    return None


# ----------------------------------------------------------------------------- FlightAware AeroAPI (free Personal tier, server-side key)
AEROAPI_BASE = "https://aeroapi.flightaware.com/aeroapi"


def aeroapi_key():
    return (os.environ.get("AEROAPI_KEY") or "").strip()


def _iso(s):
    if not s:
        return None
    try:
        return datetime.strptime(s.replace("Z", "+0000"), "%Y-%m-%dT%H:%M:%S%z").timestamp()
    except Exception:
        return None


def aeroapi_flights(canon, log):
    """Recent flights for a registration from FlightAware: list of dicts newest-first, or None when no key / error.
    Each: ident, origin/destination (iata, icao, name), off (actual departure epoch), on (actual arrival epoch), diverted, cancelled, progress."""
    key = aeroapi_key()
    if not key:
        return None
    req = urllib.request.Request(AEROAPI_BASE + "/flights/" + urllib.parse.quote(canon) + "?max_pages=1", headers={"x-apikey": key, "Accept": "application/json; charset=UTF-8", "User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            j = json.loads(r.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as e:
        log.append("FlightAware: HTTP %d%s" % (e.code, " (no flights known for this registration)" if e.code == 404 else " (check the key)" if e.code in (401, 403) else ""))
        return [] if e.code == 404 else None
    except Exception as e:
        log.append("FlightAware: unreachable (%s)" % str(e)[:60])
        return None
    out = []
    for f in j.get("flights") or []:
        def ap(x):
            x = x or {}
            return {"iata": x.get("code_iata") or "", "icao": x.get("code_icao") or x.get("code") or "", "name": x.get("name") or ""}
        out.append({"ident": f.get("ident") or "", "reg": f.get("registration") or "", "origin": ap(f.get("origin")), "destination": ap(f.get("destination")),
                    "off": _iso(f.get("actual_off")), "on": _iso(f.get("actual_on")), "sched_off": _iso(f.get("scheduled_off")), "est_on": _iso(f.get("estimated_on")),
                    "diverted": bool(f.get("diverted")), "cancelled": bool(f.get("cancelled")), "progress": f.get("progress_percent"), "status": f.get("status") or "", "position_only": bool(f.get("position_only"))})
    out.sort(key=lambda f: (f["off"] or f["sched_off"] or 0), reverse=True)
    flown = [f for f in out if f["off"]]
    log.append("FlightAware: %d flights, latest flown %s %s→%s %s" % (len(out), flown[0]["ident"], flown[0]["origin"]["iata"] or flown[0]["origin"]["icao"], flown[0]["destination"]["iata"] or flown[0]["destination"]["icao"], "landed" if flown[0]["on"] else "airborne") if flown else "FlightAware: no flown flights returned")
    return out


# ----------------------------------------------------------------------------- decision
def _is_ground_pt(p):
    return p["alt"] == "ground" or (isinstance(p["alt"], (int, float)) and p["gs"] is not None and p["gs"] < 40 and p["alt"] < 4000)


def _departure_from_trace(pts):
    """Departure airport of the current (final) airborne run. The last ground point only counts if the run starts
    close to it in time and distance; otherwise the first airborne point must itself be low and next to an airport."""
    if not pts or _is_ground_pt(pts[-1]):
        return None
    i = len(pts) - 1
    while i > 0 and not _is_ground_pt(pts[i - 1]):
        i -= 1
    first_air = pts[i]
    last_ground = pts[i - 1] if i > 0 and _is_ground_pt(pts[i - 1]) else None
    if last_ground and (first_air["t"] - last_ground["t"]) <= 45 * 60 and hav(first_air["lat"], first_air["lon"], last_ground["lat"], last_ground["lon"]) <= 60:
        n = nearest(last_ground["lat"], last_ground["lon"], 1)
        if n and n[0]["dist"] <= n[0]["radius"] + 3:
            return n[0]
    n = nearest(first_air["lat"], first_air["lon"], 1)
    if n and n[0]["dist"] <= 15 and isinstance(first_air["alt"], (int, float)) and first_air["alt"] - (n[0].get("elev") or 0) <= 5000:
        return n[0]
    return None


def _landing_inferred(fix, n0, age):
    """Last position was on final approach and nothing followed: the aircraft landed there.
    Low above the field, slow, close, not climbing, pointed at the airport (or over it), silent for 10+ minutes."""
    if not n0 or age < 600:
        return None
    alt = fix["alt"]
    elev = n0.get("elev") or 0
    agl = (alt - elev) if isinstance(alt, (int, float)) else (0 if alt == "ground" else None)
    if agl is None or agl > 2500:
        return None
    if fix["gs"] is not None and fix["gs"] > 200:
        return None
    if fix["vs"] is not None and fix["vs"] > 300:
        return None
    if n0["dist"] > 10:
        return None
    trk = fix.get("track")
    if n0["dist"] > 5 and trk is not None and _ang_diff(trk, _bearing(fix["lat"], fix["lon"], n0["lat"], n0["lon"])) > 45:
        return None
    return "last fix %s at %d ft above the field, %s kt, %.1f nm from %s, %s; no transmission since - landed" % (_fmt_z(fix["t"]), agl, ("%d" % fix["gs"]) if fix["gs"] is not None else "?", n0["dist"] / 1.852, n0["iata"] or n0["code"], "descending" if (fix["vs"] or 0) < -100 else "level")


def _last_callsign(pts):
    for p in reversed(pts):
        if p["callsign"]:
            return p["callsign"]
    return ""


def _fmt_age(sec):
    sec = max(0, int(sec))
    if sec < 90:
        return "%d s" % sec
    if sec < 5400:
        return "%d min" % round(sec / 60)
    if sec < 172800:
        return "%.1f h" % (sec / 3600)
    return "%d d" % round(sec / 86400)


def _fmt_z(t):
    return datetime.fromtimestamp(t, timezone.utc).strftime("%d %b %H:%MZ")


def _ground_dwell(pts, apt):
    """Count the trailing ground positions inside the airport boundary: (count, span_seconds)."""
    n, first, last = 0, None, None
    for p in reversed(pts):
        if not _is_ground_pt(p) or hav(p["lat"], p["lon"], apt["lat"], apt["lon"]) > apt["radius"]:
            break
        n += 1
        last = last if last is not None else p["t"]
        first = p["t"]
    return n, (last - first) if n else 0


def _bearing(lat1, lon1, lat2, lon2):
    p1, p2, dl = math.radians(lat1), math.radians(lat2), math.radians(lon2 - lon1)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def _ang_diff(a, b):
    d = abs(a - b) % 360
    return 360 - d if d > 180 else d


def locate(reg, lookback=7):
    """Full lookup for one registration. 'text' carries the website line ONLY when every verification check passes;
    otherwise it starts with 'UNVERIFIED - manual check required' and 'best_guess' holds the unconfirmed reading."""
    canon = canonical_reg(reg)
    out = {"reg": canon, "status": "unknown", "verified": False, "text": "", "best_guess": None, "checks": [], "airport": None, "from": None, "fix": None, "confidence": "low", "log": []}
    if not canon:
        out["text"] = "UNVERIFIED - manual check required - no registration given"
        return out
    log, checks = out["log"], out["checks"]

    def check(name, ok, detail):
        checks.append({"name": name, "ok": bool(ok), "detail": detail})
        return bool(ok)

    ident = identity(canon)
    hx = ident["hex"] if ident else ""
    if ident:
        out["aircraft"] = {"hex": hx, "type": ident["type"], "operator": ident["operator"]}
        log.append("registry: %s %s hex %s" % (ident["type"], ident["operator"], hx))
    else:
        log.append("registry: unknown registration")
    fixes = live_aggregators(canon, hx, log)
    if fixes and not hx:
        hx = fixes[0]["hex"]
    os_fix = live_opensky(hx, log)
    if os_fix:
        fixes.append(os_fix)
    fix = max(fixes, key=lambda f: f["t"]) if fixes else None
    now = time.time()
    fresh = fix is not None and (now - fix["t"]) <= FRESH_S
    pts, labels, trace_meta = [], [], None
    if not fresh or fix["alt"] != "ground" or True:  # the trace is needed for corroboration in every case
        pts, labels = trace_points(hx, lookback, log)
        if pts:
            trace_meta = _TRACE_META.get(hx.lower()) if hx else None
        if pts and (fix is None or pts[-1]["t"] > fix["t"] + 5):
            p = pts[-1]
            fix = {"src": "adsb.lol trace", "t": p["t"], "lat": p["lat"], "lon": p["lon"], "alt": p["alt"], "gs": p["gs"], "vs": p["vs"], "callsign": _last_callsign(pts), "hex": hx.upper(), "reg": (trace_meta or {}).get("r", "") or canon, "type": ""}
    # --- FlightAware record (when a server-side key is configured): authoritative departure/arrival events
    fa_flights = aeroapi_flights(canon, log)
    fa_last = next((f for f in (fa_flights or []) if f["off"]), None)
    fa_landed = fa_last if fa_last and fa_last["on"] else None
    fa_airborne = fa_last if fa_last and not fa_last["on"] and not fa_last["cancelled"] else None
    fa_event_t = (fa_landed["on"] if fa_landed else fa_airborne["off"] if fa_airborne else None)
    # Provider record newer than any position fix wins: a landing recorded after the last fix means the trace lost the final approach
    if fa_event_t and (fix is None or fa_event_t > fix["t"] + 5):
        if fa_landed:
            apt = airport_by_codes(fa_landed["destination"]["iata"], fa_landed["destination"]["icao"])
            if apt:
                fix = {"src": "FlightAware record", "t": fa_landed["on"], "lat": apt["lat"], "lon": apt["lon"], "alt": "ground", "gs": 0, "vs": 0, "track": None, "callsign": fa_landed["ident"], "hex": hx.upper(), "reg": fa_landed["reg"] or canon, "type": "", "record": fa_landed}
        elif fa_airborne and (fix is None or not fresh):
            fix = {"src": "FlightAware record", "t": fa_airborne["off"], "lat": float("nan"), "lon": float("nan"), "alt": None, "gs": None, "vs": None, "track": None, "callsign": fa_airborne["ident"], "hex": hx.upper(), "reg": fa_airborne["reg"] or canon, "type": "", "record": fa_airborne}
    if fix and fix["src"] == "FlightAware record" and fix.get("record") and not fix["record"]["on"]:
        return _locate_airborne_record(out, canon, fix["record"], fa_flights, now, lookback, check)
    # --- check 1: identity
    names = [f.get("reg") for f in fixes if f.get("reg")] + ([trace_meta.get("r")] if trace_meta and trace_meta.get("r") else []) + ([fa_last["reg"]] if fa_last and fa_last["reg"] else [])
    mism = [n for n in names if reg_key(n) != reg_key(canon)]
    hexes = {h.upper() for h in [f.get("hex") for f in fixes] + [hx, (trace_meta or {}).get("icao", "")] if h}
    check("Identity", not mism and len(hexes) <= 1 and (names or hx), ("source reports %s, not %s" % (mism[0], canon)) if mism else ("conflicting Mode S codes %s" % ", ".join(sorted(hexes))) if len(hexes) > 1 else ("%d source(s) name %s%s" % (len(names), canon, (", hex " + hx) if hx else "")) if (names or hx) else "no source confirms this registration")
    if not fix:
        check("Position", False, "no position fix from any source")
        out["text"] = "UNVERIFIED - manual check required - no position data for %s in the last %d days" % (canon, lookback)
        return out
    age = max(0.0, now - fix["t"])
    fresh = age <= FRESH_S
    valid = abs(fix["lat"]) <= 90 and abs(fix["lon"]) <= 180 and not (abs(fix["lat"]) < 0.01 and abs(fix["lon"]) < 0.01) and (fix["t"] - now) < 120 and age <= (lookback + 1) * 86400
    check("Fix valid", valid, "%.4f, %.4f, %s old, %s" % (fix["lat"], fix["lon"], _fmt_age(age), fix["src"]) if valid else "implausible coordinates or timestamp")
    near = nearest(fix["lat"], fix["lon"], 3)
    n0 = near[0] if near else None
    elev = n0["elev"] if n0 and n0.get("elev") is not None else 0
    alt = fix["alt"]
    on_ground = alt == "ground" or (isinstance(alt, (int, float)) and (fix["gs"] is None or fix["gs"] <= 60) and (alt - elev) <= 1500 and (fix["vs"] is None or abs(fix["vs"]) < 300))
    landing_note = None
    if not on_ground and not fresh and n0:
        landing_note = _landing_inferred(fix, n0, age)
        if landing_note:
            on_ground = True
    out["fix"] = {"lat": round(fix["lat"], 5), "lon": round(fix["lon"], 5), "time_utc": datetime.fromtimestamp(fix["t"], timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "age_s": int(age), "source": fix["src"], "altitude": alt, "ground_speed_kt": fix["gs"], "callsign": fix["callsign"], "live_sources": [f["src"] for f in fixes]}
    # --- check: live sources agree
    fresh_fixes = [f for f in fixes if (now - f["t"]) <= FRESH_S]
    agree, detail = True, "%d live source(s)" % len(fresh_fixes)
    for i in range(len(fresh_fixes)):
        for j in range(i + 1, len(fresh_fixes)):
            d = hav(fresh_fixes[i]["lat"], fresh_fixes[i]["lon"], fresh_fixes[j]["lat"], fresh_fixes[j]["lon"])
            if d > (5 if on_ground else 60):
                agree, detail = False, "%s and %s disagree by %.0f km" % (fresh_fixes[i]["src"], fresh_fixes[j]["src"], d)
    if len(fresh_fixes) > 1 and agree:
        detail = " + ".join(f["src"] for f in fresh_fixes) + " agree"
    check("Sources agree", agree, detail)

    if on_ground and n0:
        a = n0
        out["airport"] = {"iata": a["iata"], "icao": a["code"], "name": a["name"], "country": country_name(a["country"]), "distance_km": round(a["dist"], 1)}
        inside = a["dist"] <= a["radius"]
        others = [x for x in near[1:] if x["dist"] <= x["radius"] and SIZE_RANK.get(x["size"], 0) >= SIZE_RANK.get(a["size"], 0)]
        if landing_note:
            inside = True
        check("Inside airport boundary", inside and not others, ("%.1f nm from %s, outside its boundary" % (a["dist"] / 1.852, a["iata"] or a["code"])) if not inside else ("also inside %s - ambiguous" % (others[0]["iata"] or others[0]["code"])) if others else "%.1f nm from %s reference, within %.1f nm" % (a["dist"] / 1.852, a["iata"] or a["code"], a["radius"] / 1.852))
        check("On-ground state", landing_note is not None or alt == "ground" or (isinstance(alt, (int, float)) and alt - elev <= 1500 and (fix["gs"] is None or fix["gs"] <= 60)), "ground flag set by transponder" if alt == "ground" else ("landing inferred from final approach" if landing_note else "%s ft, %s kt" % (alt, fix["gs"])))
        corr, why = "", "single fix with nothing to corroborate it"
        if landing_note:
            corr = "Landing inferred: " + landing_note
        ground_fresh = [f for f in fresh_fixes if f["alt"] == "ground" or (isinstance(f["alt"], (int, float)) and f["alt"] - elev <= 1500)]
        if len(ground_fresh) > 1 and agree:
            corr = "%d independent live sources" % len(ground_fresh)
        if not corr and fix.get("record"):
            rec = fix["record"]
            corr = "FlightAware recorded %s landing at %s %s%s" % (rec["ident"], a["iata"] or a["code"], _fmt_z(rec["on"]), " (DIVERTED from %s)" % (rec["destination"]["iata"]) if rec["diverted"] else "")
        if not corr and fa_landed and airport_by_codes(fa_landed["destination"]["iata"], fa_landed["destination"]["icao"]) is a:
            corr = "FlightAware recorded %s landing here %s" % (fa_landed["ident"], _fmt_z(fa_landed["on"]))
        if not corr and pts:
            n, span = _ground_dwell(pts, a)
            if n >= 3 and span >= 120:
                corr = "trace shows %d ground positions at %s over %s with no later movement" % (n, a["iata"] or a["code"], _fmt_age(span))
            else:
                why = ("only %d ground position(s) in the trace at %s" % (n, a["iata"] or a["code"])) if n else "trace does not end on the ground here"
        check("Corroborated", bool(corr), corr or why)
        if fa_flights is not None and fa_landed:
            later = [f for f in fa_flights if f["off"] and f["off"] > fa_landed["on"]]
            check("No later departure", not later, "FlightAware shows no departure after that landing" if not later else "FlightAware shows %s departed %s afterwards" % (later[0]["ident"], _fmt_z(later[0]["off"])))
        check("Recent enough", age <= 3 * 86400, "fix %s old" % _fmt_age(age) + ("" if age <= 3 * 86400 else " - confirm manually"))
        if fix.get("record") and fix["record"]["diverted"]:
            out["diverted"] = True
        out["status"] = "ground" if inside else "ground_off_airport"
        out["confidence"] = "high" if (inside and age < 3 * 86400) else "low"
        line = airport_line(a) if inside else "%s (nearest airport, %.0f nm away, position is off-airport)" % (airport_line(a), a["dist"] / 1.852)
        if not fresh:
            out["since_utc"] = out["fix"]["time_utc"]
        if landing_note:
            out["landing_inferred"] = True
    else:
        cs = fix["callsign"] or _last_callsign(pts)
        route = route_for(cs, log) if cs else None
        dest = airport_by_codes(*route["dest"]) if route else None
        dep_trace = _departure_from_trace(pts)
        dep_trace_inside = bool(dep_trace and dep_trace["dist"] <= dep_trace["radius"])
        route_orig = airport_by_codes(*route["orig"]) if route else None
        dep = (dep_trace if dep_trace_inside else None) or route_orig
        check("Fresh in-flight fix", fresh, "%s old" % _fmt_age(age) if fresh else "track lost %s ago" % _fmt_age(age))
        check("Destination known", bool(dest), ("%s usual route for %s (%s)" % (dest["iata"] or dest["code"], cs, route["src"])) if dest else "no destination from any source")
        check("Departure observed", dep_trace_inside, ("%s from the trace" % (dep_trace["iata"] or dep_trace["code"])) if dep_trace_inside else (("%s only from the route database" % (route_orig["iata"] or route_orig["code"])) if route_orig else "departure airport unknown"))
        route_ok = not (route_orig and dep_trace_inside) or route_orig["code"] == dep_trace["code"]
        check("Route consistent", route_ok, ("route origin %s matches observed departure" % (route_orig["iata"] or route_orig["code"])) if (route_orig and dep_trace_inside and route_ok) else "nothing contradicts the route" if route_ok else "route database says %s but the aircraft departed %s - callsign may be reused" % (route_orig["iata"] or route_orig["code"], dep_trace["iata"] or dep_trace["code"]))
        if dest:
            brg = _bearing(fix["lat"], fix["lon"], dest["lat"], dest["lon"])
            d = hav(fix["lat"], fix["lon"], dest["lat"], dest["lon"])
            trk = fix.get("track")
            check("Heading toward destination", trk is None or d < 150 or _ang_diff(trk, brg) <= 90, ("track %d, destination bears %d, %.0f nm" % (trk, brg, d / 1.852)) if trk is not None else "no track reported")
        out["status"] = "enroute" if fresh else "enroute_stale"
        out["confidence"] = ("high" if dest else "medium") if fresh else "low"
        if dest:
            out["airport"] = {"iata": dest["iata"], "icao": dest["code"], "name": dest["name"], "country": country_name(dest["country"]), "basis": "usual route for callsign %s (%s)" % (cs, route["src"])}
        if dep:
            out["from"] = {"iata": dep["iata"], "icao": dep["code"], "name": dep["name"], "country": country_name(dep["country"])}
        if n0:
            out["nearest"] = {"iata": n0["iata"], "icao": n0["code"], "name": n0["name"], "country": country_name(n0["country"]), "distance_km": round(n0["dist"], 1)}
        to_txt = airport_line(dest) if dest else "destination not available (airborne near %s)" % (airport_line(n0) if n0 else "unknown position")
        from_txt = airport_line(dep) if dep else "departure airport not available"
        line = "Currently en route to %s from %s" % (to_txt, from_txt)
        if not fresh:
            line += " (last seen %s, track lost)" % _fmt_z(fix["t"])
    out["verified"] = all(c["ok"] for c in checks)
    out["best_guess"] = line
    if out["verified"]:
        out["text"] = line
    else:
        out["text"] = "UNVERIFIED - manual check required - " + "; ".join("%s: %s" % (c["name"], c["detail"]) for c in checks if not c["ok"])
    return out


def _locate_airborne_record(out, canon, rec, fa_flights, now, lookback, check):
    """In flight according to FlightAware's departure record, with no usable live position."""
    dest = airport_by_codes(rec["destination"]["iata"], rec["destination"]["icao"])
    orig = airport_by_codes(rec["origin"]["iata"], rec["origin"]["icao"])
    check("Identity", not rec["reg"] or reg_key(rec["reg"]) == reg_key(canon), "FlightAware record names %s" % (rec["reg"] or canon))
    check("Departure recorded", bool(rec["off"] and orig), "FlightAware: %s departed %s %s" % (rec["ident"], orig["iata"] if orig else "?", _fmt_z(rec["off"])) if rec["off"] else "no departure time")
    check("Destination filed", bool(dest), ("%s%s" % (dest["iata"] or dest["code"], " (diverted)" if rec["diverted"] else "")) if dest else "destination unknown")
    check("Still airborne", (now - rec["off"]) < 20 * 3600, "departed %s ago, no arrival recorded yet" % _fmt_age(now - rec["off"]) if (now - rec["off"]) < 20 * 3600 else "departed %s ago with no arrival recorded - record is stale" % _fmt_age(now - rec["off"]))
    out["status"] = "enroute"
    out["confidence"] = "high" if dest and orig else "medium"
    out["fix"] = {"source": "FlightAware record", "time_utc": datetime.fromtimestamp(rec["off"], timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "age_s": int(now - rec["off"]), "callsign": rec["ident"], "progress_percent": rec["progress"]}
    if dest:
        out["airport"] = {"iata": dest["iata"], "icao": dest["code"], "name": dest["name"], "country": country_name(dest["country"]), "basis": "FlightAware filed destination" + (" (diverted)" if rec["diverted"] else "")}
    if orig:
        out["from"] = {"iata": orig["iata"], "icao": orig["code"], "name": orig["name"], "country": country_name(orig["country"])}
    if rec["diverted"]:
        out["diverted"] = True
    line = "Currently en route to %s from %s" % (airport_line(dest) if dest else "destination not available", airport_line(orig) if orig else "departure airport not available")
    out["verified"] = all(c["ok"] for c in out["checks"])
    out["best_guess"] = line
    out["text"] = line if out["verified"] else "UNVERIFIED - manual check required - " + "; ".join("%s: %s" % (c["name"], c["detail"]) for c in out["checks"] if not c["ok"])
    return out


def locate_text(reg, lookback=7):
    return locate(reg, lookback)["text"]


# ----------------------------------------------------------------------------- server
class Handler(http.server.BaseHTTPRequestHandler):
    server_version = "TailLocator/2.1"
    days = 7

    def log_message(self, fmt, *args):
        msg = fmt % args
        if "/relay" in msg:
            msg = msg[:110] + ("..." if len(msg) > 110 else "")
        sys.stdout.write("  " + msg + "\n")
        sys.stdout.flush()

    def _send(self, status, body, ctype="application/json; charset=utf-8", extra=None):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def do_OPTIONS(self):
        self._send(204, b"", extra={"Access-Control-Allow-Methods": "GET,OPTIONS", "Access-Control-Allow-Headers": "*", "Access-Control-Max-Age": "86400"})

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        u = urllib.parse.urlsplit(self.path)
        q = urllib.parse.parse_qs(u.query)
        if u.path in ("/", "/index.html"):
            return self.serve_html()
        if u.path == "/ping":
            return self._send(200, json.dumps({"ok": True, "relay": "local", "version": "2.4", "locate": "/locate?reg=EI-DEI", "flightaware": bool(aeroapi_key())}))
        if u.path == "/relay":
            return self.relay(q.get("url", [""])[0])
        if u.path == "/locate":
            return self.locate_endpoint(q)
        if u.path == "/favicon.ico":
            return self._send(204, b"", ctype="image/x-icon")
        self._send(404, json.dumps({"error": "not found", "endpoints": ["/", "/ping", "/relay?url=", "/locate?reg="]}))

    def serve_html(self):
        try:
            with open(HTML_FILE, "rb") as f:
                self._send(200, f.read(), ctype="text/html; charset=utf-8")
        except FileNotFoundError:
            self._send(500, "<h1>Tail-Locator.html not found</h1><p>Put it in the same folder as tail_locator.py: <code>%s</code></p>" % HERE, ctype="text/html; charset=utf-8")

    def locate_endpoint(self, q):
        regs = [r for r in re.split(r"[\s,;]+", (q.get("reg", [""])[0] or "")) if r]
        if not regs:
            return self._send(400, json.dumps({"ok": False, "error": "usage: /locate?reg=EI-DEI  (several: reg=EI-DEI,G-XWBA)  optional &days=7"}))
        try:
            days = max(1, min(14, int(q.get("days", [str(self.days)])[0])))
        except ValueError:
            days = self.days
        fmt = (q.get("format", ["json"])[0] or "json").lower()
        results = [locate(r, days) for r in regs[:15]]
        if fmt == "text":
            return self._send(200, "\n".join(r["text"] for r in results), ctype="text/plain; charset=utf-8")
        payload = {"ok": True, "results": results, "text": results[0]["text"], "verified": results[0]["verified"], "status": results[0]["status"], "reg": results[0]["reg"], "generated_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}
        self._send(200, json.dumps(payload, ensure_ascii=False))

    def relay(self, target):
        if not target:
            return self._send(400, json.dumps({"error": "usage: /relay?url=<encoded https url>"}))
        try:
            t = urllib.parse.urlsplit(target)
        except ValueError:
            return self._send(400, json.dumps({"error": "bad url"}))
        if t.scheme != "https" or t.hostname not in ALLOW:
            return self._send(403, json.dumps({"error": "host not allowed", "host": t.hostname}))
        try:
            status, body, ctype = http_get(target)
        except Exception as e:
            return self._send(502, json.dumps({"error": "upstream unreachable", "detail": str(e)[:200], "host": t.hostname}))
        self._send(status, body, ctype=ctype)


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def pick_port(start):
    for p in range(start, start + 20):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            if s.connect_ex(("127.0.0.1", p)) != 0:
                return p
    raise SystemExit("No free port found near %d" % start)


def main():
    ap = argparse.ArgumentParser(description="Tail Locator — local launcher and lookup engine")
    ap.add_argument("command", nargs="?", default="serve", help="serve (default) | locate REG [REG ...]")
    ap.add_argument("regs", nargs="*")
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8765")))
    ap.add_argument("--host", default=os.environ.get("HOST", "127.0.0.1"), help="bind address; 0.0.0.0 when hosted (Render sets PORT)")
    ap.add_argument("--no-browser", action="store_true")
    ap.add_argument("--days", type=int, default=7, help="history look-back for parked aircraft (1-14)")
    ap.add_argument("--json", action="store_true", help="with locate: print full JSON instead of the text line")
    args = ap.parse_args()
    if args.command == "locate" or (args.command != "serve" and canonical_reg(args.command)):
        regs = ([] if args.command == "locate" else [args.command]) + args.regs
        if not regs:
            raise SystemExit("usage: python tail_locator.py locate EI-DEI [G-XWBA ...]")
        for r in regs:
            res = locate(r, max(1, min(14, args.days)))
            print(json.dumps(res, ensure_ascii=False, indent=2) if args.json else res["text"])
        return
    Handler.days = max(1, min(14, args.days))
    hosted = args.host != "127.0.0.1" or "PORT" in os.environ
    port = args.port if hosted else pick_port(args.port)
    url = "http://127.0.0.1:%d/" % port
    if not os.path.exists(HTML_FILE):
        print("WARNING: Tail-Locator.html not found next to this script (%s)." % HERE)
    _load_data()
    srv = Server((args.host, port), Handler)
    print("Tail Locator")
    print("  page:    %s" % url)
    print("  locate:  %slocate?reg=EI-DEI   (JSON; add &format=text for the bare line)" % url)
    print("  relay:   %srelay?url=...   allowed: %s" % (url, ", ".join(sorted(ALLOW))))
    print("  airports: %d loaded   FlightAware key: %s   stop: Ctrl+C" % (len(airports()), "set" if aeroapi_key() else "not set (AEROAPI_KEY)"))
    if not args.no_browser and not hosted:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")


if __name__ == "__main__":
    main()
