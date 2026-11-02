"""FastAPI app: REST endpoints, the engine websocket and the built UI."""
from __future__ import annotations

import asyncio
import json
import re
import urllib.error
import urllib.parse
import urllib.request
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from chessvision import PIECE_CODES
from chessvision.pieces import LILA_PIECE_URL

from . import engines, games_db, vision
from .paths import DATA, UI_DIST



@asynccontextmanager
async def lifespan(_: FastAPI):
    yield
    engines.shutdown()


app = FastAPI(title="chessvision", lifespan=lifespan)
PIECE_CACHE = DATA / "pieces"


@app.exception_handler(FileNotFoundError)
async def _not_found(_: Request, ex: FileNotFoundError):
    return JSONResponse({"detail": str(ex)}, status_code=404)


@app.exception_handler(ValueError)
async def _bad_request(_: Request, ex: ValueError):
    return JSONResponse({"detail": str(ex)}, status_code=400)


def _lichess_headers(request: Request) -> dict:
    token = request.headers.get("x-lichess-token")
    return {"Authorization": f"Bearer {token}"} if token else {}


async def _fetch(url: str, headers: dict | None = None, timeout: int = 20) -> Response:
    """Proxy a GET (avoids CORS and keeps the Lichess token out of third-party pages)."""
    def get():
        req = urllib.request.Request(url, headers={"User-Agent": games_db.USER_AGENT,
                                                   "Accept": "application/json", **(headers or {})})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.status, r.read(), r.headers.get("content-type", "application/json")
        except urllib.error.HTTPError as e:
            return e.code, e.read(), e.headers.get("content-type", "text/plain")
        except (urllib.error.URLError, TimeoutError) as e:
            return 502, json.dumps({"detail": f"Network error: {e}"}).encode(), "application/json"
    status, body, ctype = await asyncio.to_thread(get)
    return Response(body, status_code=status, media_type=ctype)


# ---------------------------------------------------------------- vision

@app.post("/api/vision/recognize")
async def recognize(request: Request, bbox: str | None = None, turn: str = "w", orientation: str = "auto"):
    data = await request.body()
    if not data:
        raise HTTPException(400, "Empty upload")
    box = tuple(float(v) for v in bbox.split(",")) if bbox else None
    if box is not None and (len(box) != 4 or box[2] < 16 or box[3] < 16):
        raise HTTPException(400, "bbox must be x,y,w,h with a size of at least 16px")
    if orientation not in ("auto", "white", "black"):
        raise HTTPException(400, "orientation must be auto, white or black")
    try:
        return await asyncio.to_thread(vision.recognize_image, data, box, turn, orientation)
    except OSError as ex:
        raise HTTPException(400, f"Not an image the server can read ({ex})")


# ---------------------------------------------------------------- engines

@app.get("/api/engines")
async def list_engines():
    return await asyncio.to_thread(engines.registry.list)


@app.post("/api/engines")
async def add_engine(body: dict):
    try:
        return await asyncio.to_thread(engines.registry.add, body.get("path", ""), body.get("name"))
    except (OSError, engines.chess.engine.EngineError) as ex:
        raise HTTPException(400, f"Could not start the engine: {ex}")


@app.delete("/api/engines/{engine_id}")
async def remove_engine(engine_id: str):
    engines.registry.remove(engine_id)
    return {"ok": True}


@app.post("/api/engine/bestmove")
async def bestmove(body: dict):
    return await asyncio.to_thread(engines.best_move, body)


@app.websocket("/ws")
async def engine_socket(ws: WebSocket):
    """Live analysis and game reports.

    client -> {type: analyze, id, token, engine, fen, moves, multipv, threads, hash, options, limit}
              {type: stop|close, id}   {type: report, id, engine, fen, moves, limit}   {type: report_cancel, id}
    server -> {type: analysis, id, token, depth, nodes, nps, lines: [...], done}
              {type: report_progress|report_done|report_error|error, id, ...}
    """
    await ws.accept()
    loop = asyncio.get_running_loop()
    outbox: asyncio.Queue = asyncio.Queue()
    sessions: dict[str, engines.AnalysisSession] = {}
    reports: dict[str, engines.ReportJob] = {}

    def send(msg: dict):
        loop.call_soon_threadsafe(outbox.put_nowait, msg)

    async def pump():
        while True:
            msg = await outbox.get()
            await ws.send_json(msg)

    sender = asyncio.create_task(pump())
    try:
        while True:
            msg = await ws.receive_json()
            kind, key = msg.get("type"), str(msg.get("id", ""))
            if kind == "analyze":
                s = sessions.get(key)
                if s is None or s.engine_id != msg.get("engine"):
                    if s is not None:
                        s.close()
                    s = sessions[key] = engines.AnalysisSession(key, msg.get("engine", "stockfish"), send)
                s.request(msg)
            elif kind == "stop" and key in sessions:
                sessions[key].stop()
            elif kind == "close" and key in sessions:
                sessions.pop(key).close()
            elif kind == "report":
                if key in reports:
                    reports[key].cancel()
                reports[key] = engines.ReportJob(key, msg, send)
            elif kind == "report_cancel" and key in reports:
                reports.pop(key).cancel()
    except WebSocketDisconnect:
        pass
    finally:
        for s in sessions.values():
            s.close()
        for r in reports.values():
            r.cancel()
        sender.cancel()


# ---------------------------------------------------------------- databases

@app.get("/api/databases")
async def databases():
    return await asyncio.to_thread(games_db.list_databases)


@app.post("/api/databases")
async def create_db(body: dict):
    return games_db.create_database(body.get("name", ""), body.get("description", ""))


@app.delete("/api/databases/{name}")
async def delete_db(name: str):
    games_db.delete_database(name)
    return {"ok": True}


@app.post("/api/databases/{name}/import")
async def import_db(name: str, request: Request):
    text = (await request.body()).decode("utf-8", "replace")
    jid = games_db.start_job(f"Import into {name}", lambda progress: games_db.import_pgn(name, text, progress))
    return {"job": jid}


@app.post("/api/databases/{name}/download")
async def download_db(name: str, body: dict, request: Request):
    source, user = body.get("source"), (body.get("username") or "").strip()
    max_games = max(1, min(int(body.get("max", 200)), 5000))
    if not user:
        raise HTTPException(400, "Enter a username")
    token = request.headers.get("x-lichess-token")

    def job(progress):
        progress(0.02, f"downloading games of {user}")
        if source == "lichess":
            text = games_db.download_lichess(user, max_games, token)
        elif source == "chesscom":
            text = games_db.download_chesscom(user, max_games, progress)
        else:
            raise ValueError("source must be lichess or chesscom")
        progress(0.5, "importing")
        return games_db.import_pgn(name, text, lambda f, m: progress(0.5 + f / 2, m))
    return {"job": games_db.start_job(f"Download {user} from {source}", job)}


@app.get("/api/jobs/{jid}")
async def job(jid: str):
    return games_db.get_job(jid)


@app.get("/api/databases/{name}/games")
async def games(name: str, player: str = "", white: str = "", black: str = "", event: str = "",
                result: str = "", sort: str = "id", desc: bool = True, offset: int = 0, limit: int = 50):
    return await asyncio.to_thread(games_db.search_games, name, player, white, black, event, result,
                                   sort, desc, offset, min(limit, 500))


@app.post("/api/databases/{name}/games")
async def add_game(name: str, request: Request):
    pgn = (await request.body()).decode("utf-8", "replace")
    return {"id": await asyncio.to_thread(games_db.add_game, name, pgn)}


@app.get("/api/databases/{name}/games/{game_id}")
async def game(name: str, game_id: int):
    return games_db.get_game(name, game_id)


@app.delete("/api/databases/{name}/games/{game_id}")
async def delete_game(name: str, game_id: int):
    games_db.delete_game(name, game_id)
    return {"ok": True}


@app.get("/api/databases/{name}/explore")
async def explore(name: str, fen: str):
    return await asyncio.to_thread(games_db.explore, name, fen)


# ---------------------------------------------------------------- lichess proxies

@app.get("/api/lichess/explorer/{db}")
async def lichess_explorer(db: str, request: Request):
    if db not in ("masters", "lichess", "player"):
        raise HTTPException(404, "Unknown explorer database")
    q = urllib.parse.urlencode(list(request.query_params.multi_items()))
    return await _fetch(f"https://explorer.lichess.ovh/{db}?{q}", _lichess_headers(request))


@app.get("/api/lichess/game/{gid}")
async def lichess_game(gid: str, request: Request, masters: bool = False):
    if not re.fullmatch(r"[A-Za-z0-9]{6,12}", gid):
        raise HTTPException(404)
    url = (f"https://explorer.lichess.ovh/masters/pgn/{gid}" if masters
           else f"https://lichess.org/game/export/{gid}?clocks=true&evals=false")
    return await _fetch(url, {**_lichess_headers(request), "Accept": "application/x-chess-pgn"})


@app.get("/api/lichess/puzzle")
async def lichess_puzzle(request: Request, angle: str = "", difficulty: str = ""):
    q = urllib.parse.urlencode({k: v for k, v in (("angle", angle), ("difficulty", difficulty)) if v})
    return await _fetch(f"https://lichess.org/api/puzzle/next?{q}", _lichess_headers(request))


@app.get("/api/lichess/puzzle/daily")
async def lichess_daily(request: Request):
    return await _fetch("https://lichess.org/api/puzzle/daily", _lichess_headers(request))


# ---------------------------------------------------------------- piece sets

@app.get("/pieces/{piece_set}/{code}.svg")
async def piece(piece_set: str, code: str):
    if not re.fullmatch(r"[a-z0-9\-]{1,32}", piece_set) or code not in PIECE_CODES:
        raise HTTPException(404)
    path = PIECE_CACHE / piece_set / f"{code}.svg"
    if not path.exists():
        def download():
            with urllib.request.urlopen(LILA_PIECE_URL.format(set=piece_set, code=code), timeout=20) as r:
                return r.read()
        try:
            data = await asyncio.to_thread(download)
        except (urllib.error.URLError, TimeoutError):
            raise HTTPException(404, "Piece set not available offline")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    return FileResponse(path, media_type="image/svg+xml", headers={"Cache-Control": "max-age=604800"})


# ---------------------------------------------------------------- sounds

LILA_SOUND_URL = "https://raw.githubusercontent.com/lichess-org/lila/master/public/sound/standard/{name}.mp3"
SOUND_CACHE = DATA / "sounds"
SOUND_NAMES = {"Move", "Capture", "GenericNotify", "Error", "Confirmation"}


@app.get("/sounds/{name}.mp3")
async def sound(name: str):
    if name not in SOUND_NAMES:
        raise HTTPException(404)
    path = SOUND_CACHE / f"{name}.mp3"
    if not path.exists():
        def download():
            with urllib.request.urlopen(LILA_SOUND_URL.format(name=name), timeout=20) as r:
                return r.read()
        try:
            data = await asyncio.to_thread(download)
        except (urllib.error.URLError, TimeoutError):
            raise HTTPException(404, "Sound not available offline")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    return FileResponse(path, media_type="audio/mpeg", headers={"Cache-Control": "max-age=604800"})


# ---------------------------------------------------------------- UI

if UI_DIST.exists():
    app.mount("/", StaticFiles(directory=UI_DIST, html=True), name="ui")
else:
    @app.get("/")
    async def no_ui():
        return HTMLResponse("<h2>UI not built</h2><p>Run <code>npm install && npm run build</code> "
                            "in the <code>ui/</code> folder, then restart.</p>")
