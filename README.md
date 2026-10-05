# Tail Locator

Looks up where an aircraft is right now from its registration and returns one verified line:

```
SNN - Shannon Airport - Ireland
Currently en route to LHR - London Heathrow Airport - United Kingdom from DUB - Dublin Airport - Ireland
UNVERIFIED - manual check required - <reason>
```

Free data only (adsb.lol, airplanes.live, adsb.fi, OpenSky, adsb.lol trace archive, adsbdb, hexdb, OurAirports). No API keys, no accounts. Flightradar24 API is optional.

## Run

Keep the files in `dist/` together and double-click `Start-Tail-Locator.bat` (Windows) or run `python tail_locator.py`. It opens `http://127.0.0.1:8765/` and relays the API calls the browser is not allowed to make itself.

## Use from your own site

```js
const r = await fetch('http://127.0.0.1:8765/locate?reg=EI-DEI');
const j = await r.json();          // j.text, j.verified, j.status, j.checks
```

Python: `import tail_locator; tail_locator.locate_text("EI-DEI")`. CLI: `python tail_locator.py locate EI-DEI`.

## Verification

The line is produced only when every check passes (identity, fix validity, source agreement, airport boundary, ground state, corroboration, freshness; in flight: destination known, departure observed, route consistency, heading, track consistency). Otherwise the output is `UNVERIFIED` with the failing checks. See the Developer tab in the page.

## Layout

- `dist/` — what you run: `Tail-Locator.html`, `tail_locator.py`, `airports.json`, `Start-Tail-Locator.bat`, `tail-relay-worker.js` (optional Cloudflare relay)
- `src/` — page sources (`head.html`, `body.html`, `app.js`); `build.py` assembles `dist/Tail-Locator.html`
- `test/` — Playwright browser tests (`node test/run2.js`) and engine tests (`python test/test_py.py`)

Data licences: adsb.lol / airplanes.live / adsb.fi are community feeds for personal, non-commercial use (ODbL); OpenSky CC BY-SA; OurAirports public domain. Positions are surveillance data and can be wrong.
