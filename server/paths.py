from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"            # user data: engines.json, databases/, piece cache
UI_DIST = ROOT / "ui" / "dist"  # built frontend (npm run build in ui/)
MODEL = ROOT / "models" / "squarenet.npz"

DATA.mkdir(exist_ok=True)
