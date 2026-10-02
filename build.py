"""Build zotero-tag-logic.xpi (a zip with manifest.json at its root)."""
import json, zipfile, pathlib

root = pathlib.Path(__file__).parent
version = json.loads((root / "manifest.json").read_text(encoding="utf-8"))["version"]
out = root / "dist" / f"zotero-tag-logic-{version}.xpi"
out.parent.mkdir(exist_ok=True)
files = ["manifest.json", "bootstrap.js", "prefs.js"]
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for f in files:
        z.write(root / f, f)
print(out)
