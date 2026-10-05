"""In-process tests for tail_locator.py's lookup engine with the network mocked."""
import sys, os, time, json, math
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "dist"))
import tail_locator as tl

fails = 0
def check(name, cond, extra=""):
    global fails
    print(("PASS  " if cond else "FAIL  ") + name + (("  — " + str(extra)) if extra else ""))
    if not cond:
        fails += 1

SNN = (52.7011, -8.9180); DUB = (53.4264, -6.2499); LHR = (51.4706, -0.4619)

def make_trace(hex_, reg, A, B, callsign, end_ago_s, lost=False):
    end_t = time.time() - end_ago_s; dur = 3600; start = end_t - dur - 1200; base = start
    tr = []
    def push(t, lat, lon, alt, gs, ac=None):
        tr.append([t - base, round(lat, 5), round(lon, 5), alt, gs, 240, 0, 0 if alt == "ground" else (2000 if t < start + 600 + dur / 2 else -1800), ac, "adsb_icao", None if alt == "ground" else alt, None, None])
    for s in range(0, 600, 60):
        push(start + s, A[0], A[1], "ground", 0, {"flight": callsign, "squawk": "1234"} if s == 0 else None)
    n = 60
    for i in range(1, n + 1):
        f = i / n
        push(start + 600 + i * dur / n, A[0] + (B[0] - A[0]) * f, A[1] + (B[1] - A[1]) * f, max(int(36000 * math.sin(math.pi * f)), 500), 420, {"flight": callsign} if i == 2 else None)
    if not lost:
        for s in range(0, 600, 60):
            push(start + 600 + dur + s, B[0], B[1], "ground", 0)
    return {"icao": hex_.lower(), "r": reg, "t": "A320", "dbFlags": 0, "desc": "AIRBUS A-320", "timestamp": base, "trace": tr}

IDENT = {"response": {"aircraft": {"mode_s": "4CA281", "icao_type": "A320", "registered_owner": "Aer Lingus", "registration": "EI-DEI"}}}
ROUTE_DUB_LHR = {"response": {"flightroute": {"callsign": "EIN123", "origin": {"iata_code": "DUB", "icao_code": "EIDW"}, "destination": {"iata_code": "LHR", "icao_code": "EGLL"}}}}

def mock(scenario):
    calls = []
    def get_json(url, timeout=0):
        calls.append(url)
        return scenario(url)
    def http_get(url, timeout=0):
        calls.append(url)
        return 404, b"Not Found", "text/plain"
    tl.get_json = get_json; tl.http_get = http_get; tl.time.sleep = lambda s: None
    return calls

# ---- data loaded
check("airports loaded", len(tl.airports()) == 9765, len(tl.airports()))
check("country names", tl.country_name("IE") == "Ireland" and tl.country_name("GB") == "United Kingdom" and tl.country_name("US") == "United States")
check("airport_line SNN", tl.airport_line(tl.airport_by_codes("SNN")) == "SNN - Shannon Airport - Ireland", tl.airport_line(tl.airport_by_codes("SNN")))
check("airport_line by ICAO only", tl.airport_line(tl.airport_by_codes("", "EGLL")) == "LHR - London Heathrow Airport - United Kingdom")
check("canonical_reg", [tl.canonical_reg(x) for x in ["eidei", "N789AN", "GXWBA", "ja8089", "VPBAA", "9VSKA", "EI-DEI"]] == ["EI-DEI", "N789AN", "G-XWBA", "JA8089", "VP-BAA", "9V-SKA", "EI-DEI"])
check("nearest SNN", tl.nearest(*SNN, 1)[0]["iata"] == "SNN")

# ---- scenario 1: parked at SNN, transponder off 4 h, found in recent trace
trace = make_trace("4CA281", "EI-DEI", DUB, SNN, "EIN123", 4 * 3600)
def sc1(url):
    if "adsbdb.com/v0/aircraft/EI-DEI" in url: return IDENT
    if "/v2/reg/" in url or "/v2/hex/" in url or "registration/" in url: return {"ac": [], "total": 0, "now": time.time() * 1000}
    if "opensky" in url: return {"time": int(time.time()), "states": None}
    if "data/traces/81/trace_full_4ca281.json" in url: return trace
    return None
calls = mock(sc1)
r = tl.locate("EI-DEI", 7)
check("S1 text (verified by trace dwell)", r["text"] == "SNN - Shannon Airport - Ireland" and r["verified"], (r["text"], [c for c in r["checks"] if not c["ok"]]))
check("S1 status/conf", r["status"] == "ground" and r["confidence"] == "high" and r["fix"]["source"] == "adsb.lol trace", (r["status"], r["confidence"], r["fix"]["source"]))
check("S1 since set (stale fix)", "since_utc" in r)
check("S1 aggregator calls made before trace", any("api.adsb.lol/v2/reg/EI-DEI,EIDEI" in c for c in calls) and any("trace_full_4ca281" in c for c in calls))

# ---- scenario 2: airborne live (adsb.lol), route DUB→LHR, departure from trace
def sc2(url):
    if "adsbdb.com/v0/aircraft/EI-DEI" in url: return IDENT
    if "api.adsb.lol/v2/reg/" in url: return {"ac": [{"hex": "4ca281", "r": "EI-DEI", "t": "A320", "flight": "EIN123 ", "alt_baro": 36000, "gs": 450, "track": 110, "baro_rate": 0, "lat": 53.1, "lon": -4.6, "seen_pos": 3, "seen": 1}], "total": 1, "now": time.time() * 1000}
    if "adsbdb.com/v0/callsign/EIN123" in url: return ROUTE_DUB_LHR
    if "data/traces/81/trace_full_4ca281.json" in url: return make_trace("4CA281", "EI-DEI", DUB, (53.1, -4.6), "EIN123", 10, lost=True)
    return None
calls = mock(sc2)
r = tl.locate("eidei", 7)
check("S2 en route text (verified)", r["text"] == "Currently en route to LHR - London Heathrow Airport - United Kingdom from DUB - Dublin Airport - Ireland" and r["verified"], (r["text"], [c for c in r["checks"] if not c["ok"]]))
check("S2 status enroute, high", r["status"] == "enroute" and r["confidence"] == "high", (r["status"], r["confidence"]))
check("S2 from derived from trace", r["from"]["iata"] == "DUB")

# ---- scenario 3: airborne, no route known, no trace → destination not available
def sc3(url):
    if "adsbdb.com/v0/aircraft/EI-DEI" in url: return IDENT
    if "api.adsb.lol/v2/reg/" in url: return {"ac": [{"hex": "4ca281", "r": "EI-DEI", "flight": "", "alt_baro": 35000, "gs": 440, "lat": 52.0, "lon": -12.0, "seen_pos": 2}], "now": time.time() * 1000}
    return None
mock(sc3)
r = tl.locate("EI-DEI", 7)
check("S3 unknown destination → UNVERIFIED, best guess kept", r["text"].startswith("UNVERIFIED - manual check required - ") and "Destination known" in r["text"] and r["best_guess"].startswith("Currently en route to destination not available"), r["text"])
check("S3 medium confidence", r["confidence"] == "medium")

# ---- scenario 4: nothing anywhere
def sc4(url):
    if "/v2/" in url or "registration/" in url: return {"ac": []}
    return None
mock(sc4)
r = tl.locate("ZZ-TEST", 7)
check("S4 no data text", r["text"] == "UNVERIFIED - manual check required - no position data for ZZ-TEST in the last 7 days" and r["status"] == "unknown" and not r["verified"], r["text"])

# ---- scenario 5: on ground but outside any airport boundary
def sc5(url):
    if "adsbdb.com/v0/aircraft/EI-DEI" in url: return IDENT
    if "api.adsb.lol/v2/reg/" in url: return {"ac": [{"hex": "4ca281", "r": "EI-DEI", "alt_baro": "ground", "gs": 0, "lat": 52.60, "lon": -8.70, "seen_pos": 5}], "now": time.time() * 1000}
    return None
mock(sc5)
r = tl.locate("EI-DEI", 7)
check("S5 off-airport → UNVERIFIED", r["status"] == "ground_off_airport" and r["text"].startswith("UNVERIFIED") and "outside its boundary" in r["text"] and "off-airport" in r["best_guess"], r["text"])

# ---- scenario 6: single live ground fix at SNN, no trace, no second source → must fail closed
def sc6(url):
    if "adsbdb.com/v0/aircraft/EI-DEI" in url: return IDENT
    if "api.adsb.lol/v2/reg/" in url: return {"ac": [{"hex": "4ca281", "r": "EI-DEI", "alt_baro": "ground", "gs": 0, "lat": SNN[0], "lon": SNN[1], "seen_pos": 5}], "now": time.time() * 1000}
    return None
mock(sc6)
r = tl.locate("EI-DEI", 7)
check("S6 single uncorroborated fix → UNVERIFIED", not r["verified"] and r["text"].startswith("UNVERIFIED") and "Corroborated" in r["text"] and r["best_guess"] == "SNN - Shannon Airport - Ireland", r["text"])

# ---- scenario 7: two live sources agree on ground at SNN → verified without trace
def sc7(url):
    if "adsbdb.com/v0/aircraft/EI-DEI" in url: return IDENT
    if "api.adsb.lol/v2/reg/" in url or "api.airplanes.live/v2/reg/" in url: return {"ac": [{"hex": "4ca281", "r": "EI-DEI", "alt_baro": "ground", "gs": 0, "lat": SNN[0], "lon": SNN[1], "seen_pos": 5}], "now": time.time() * 1000}
    if "adsb.fi" in url: return {"ac": []}
    return None
mock(sc7)
r = tl.locate("EI-DEI", 7)
check("S7 two sources agree → verified", r["verified"] and r["text"] == "SNN - Shannon Airport - Ireland" and "independent live sources" in [c["detail"] for c in r["checks"] if c["name"] == "Corroborated"][0], r["text"])

# ---- scenario 8: identity mismatch (source names another reg for the hex) → UNVERIFIED
def sc8(url):
    if "adsbdb.com/v0/aircraft/EI-DEI" in url: return IDENT
    if "api.adsb.lol/v2/reg/" in url: return {"ac": []}
    if "api.adsb.lol/v2/hex/" in url: return {"ac": [{"hex": "4ca281", "r": "EI-XYZ", "alt_baro": "ground", "gs": 0, "lat": SNN[0], "lon": SNN[1], "seen_pos": 5}], "now": time.time() * 1000}
    if "airplanes.live" in url or "adsb.fi" in url: return {"ac": []}
    return None
mock(sc8)
r = tl.locate("EI-DEI", 7)
check("S8 identity mismatch → UNVERIFIED", not r["verified"] and "Identity" in r["text"] and "EI-XYZ" in r["text"], r["text"])

# ---- scenario 9: route origin contradicts observed departure (callsign reuse) → UNVERIFIED
def sc9(url):
    if "adsbdb.com/v0/aircraft/EI-DEI" in url: return IDENT
    if "api.adsb.lol/v2/reg/" in url: return {"ac": [{"hex": "4ca281", "r": "EI-DEI", "flight": "EIN123", "alt_baro": 36000, "gs": 450, "track": 110, "lat": 53.1, "lon": -4.6, "seen_pos": 3}], "now": time.time() * 1000}
    if "adsbdb.com/v0/callsign/EIN123" in url: return {"response": {"flightroute": {"origin": {"iata_code": "SNN", "icao_code": "EINN"}, "destination": {"iata_code": "LHR", "icao_code": "EGLL"}}}}
    if "data/traces/81/trace_full_4ca281.json" in url: return make_trace("4CA281", "EI-DEI", DUB, (53.1, -4.6), "EIN123", 10, lost=True)
    return None
mock(sc9)
r = tl.locate("EI-DEI", 7)
check("S9 route contradicts observed departure → UNVERIFIED", not r["verified"] and "Route consistent" in r["text"] and "callsign may be reused" in r["text"], r["text"])

print("\n%d FAILURE(S)" % fails if fails else "\nALL PASS")
sys.exit(1 if fails else 0)
