#!/usr/bin/env python3
"""Assemble the standalone Tail Locator HTML file."""
import json, pathlib, re

ROOT = pathlib.Path(__file__).parent
SRC = ROOT / "src"
SCRATCH = pathlib.Path("/tmp/claude-0/-home-claude/65453728-be25-5332-aef2-750b49f75f65/scratchpad")
OUT = ROOT / "dist" / "Tail-Locator.html"
OUT.parent.mkdir(exist_ok=True)

head = (SRC / "head.html").read_text(encoding="utf-8")
body = (SRC / "body.html").read_text(encoding="utf-8")
app = (SRC / "app.js").read_text(encoding="utf-8")
airports = (SCRATCH / "airports_compact.json").read_text(encoding="utf-8")
countries = (SCRATCH / "countries_compact.json").read_text(encoding="utf-8")
# guard against accidental script-closing sequences inside embedded data
airports_safe = airports.replace("</", "<\\/")
app_safe = app.replace("</script", "<\\/script")

n_airports = len(json.loads(airports))
body = body.replace("9,765 airports", f"{n_airports:,} airports")

html = (
    head + body +
    '\n<script src="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js" crossorigin="anonymous" referrerpolicy="no-referrer"></script>\n'
    '<script>window.AIRPORTS=' + airports_safe + ';</script>\n'
    '<script>window.COUNTRIES=' + countries.replace('</', '<\\/') + ';</script>\n'
    '<script>\n' + app_safe + '\n</script>\n</body>\n</html>\n'
)
OUT.write_text(html, encoding="utf-8")
m = re.search(r"const WORKER_CODE = `([\s\S]*?)`;", app)
(OUT.parent / "tail-relay-worker.js").write_text(m.group(1) + "\n", encoding="utf-8")
print(f"wrote {OUT} ({OUT.stat().st_size/1024:.0f} KB, {n_airports} airports) + tail-relay-worker.js")
