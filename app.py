#!/usr/bin/env python3
"""Start the chessvision UI: analysis board, engines, databases and screenshot import.

    python app.py                 # http://127.0.0.1:8765, opens your browser
    python app.py --port 9000 --no-browser
"""
from __future__ import annotations

import argparse
import asyncio
import threading
import webbrowser

import uvicorn


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()

    server = uvicorn.Server(uvicorn.Config("server.main:app", host=args.host, port=args.port,
                                           log_level="warning"))
    url = f"http://{args.host}:{args.port}"
    print(f"chessvision UI running at {url}  (Ctrl+C to stop)")
    if not args.no_browser:
        threading.Timer(1.0, webbrowser.open, (url,)).start()
    asyncio.run(server.serve())


if __name__ == "__main__":
    main()
