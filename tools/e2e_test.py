"""Run the full pipeline on the test screenshots and compare with ground truth."""
import json
import subprocess
import sys
from pathlib import Path

T = Path(sys.argv[1] if len(sys.argv) > 1 else "test_screens")
SF = sys.argv[2] if len(sys.argv) > 2 else "stockfish"
truth = json.load(open(T / "truth.json"))
ok = 0
for name, t in truth.items():
    cmd = [sys.executable, str(Path(__file__).resolve().parents[1] / "analyze.py"), str(T / f"{name}.png"),
           "--turn", t["turn"], "--engine", SF, "--time", "1", "--debug"]
    r = subprocess.run(cmd, capture_output=True, text=True)
    fen_line = [l for l in r.stdout.splitlines() if l.startswith("FEN:")]
    got = fen_line[0].split()[1] if fen_line else None
    match = got == t["fen"]
    ok += match
    print(f"=== {name}: {'OK' if match else 'MISMATCH'}")
    if not match:
        print("  expected", t["fen"], "\n  got     ", got)
    print("\n".join("  " + l for l in r.stdout.splitlines()[-6:]))
    if r.returncode:
        print("  STDERR:", r.stderr[-600:])
print(f"\n{ok}/{len(truth)} positions read exactly")
