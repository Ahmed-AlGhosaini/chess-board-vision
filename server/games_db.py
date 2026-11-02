"""Local game databases: one SQLite file per database.

Besides the game headers and PGN, the first MAX_INDEX_PLY positions of every
game's main line are indexed by Polyglot Zobrist hash together with the move
played from there. That turns "which moves were played here, and how did
those games end?" into a single indexed GROUP BY.
"""
from __future__ import annotations

import io
import json
import re
import sqlite3
import threading
import time
import urllib.parse
import urllib.request
import uuid
from contextlib import contextmanager
from pathlib import Path

import chess
import chess.pgn
import chess.polyglot

from .paths import DATA

DB_DIR = DATA / "databases"
DB_DIR.mkdir(parents=True, exist_ok=True)
MAX_INDEX_PLY = 60
USER_AGENT = "chessvision-ui/1.0 (local analysis app)"

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS games(
    id INTEGER PRIMARY KEY,
    event TEXT, site TEXT, date TEXT, round TEXT,
    white TEXT, black TEXT, result TEXT,
    white_elo INTEGER, black_elo INTEGER,
    eco TEXT, opening TEXT, time_control TEXT,
    ply_count INTEGER, pgn TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS positions(
    hash INTEGER NOT NULL, game_id INTEGER NOT NULL, ply INTEGER NOT NULL, move TEXT);
CREATE INDEX IF NOT EXISTS idx_positions_hash ON positions(hash);
CREATE INDEX IF NOT EXISTS idx_positions_game ON positions(game_id);
CREATE INDEX IF NOT EXISTS idx_games_white ON games(white COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_games_black ON games(black COLLATE NOCASE);
"""

GAME_COLUMNS = ("id", "event", "site", "date", "round", "white", "black", "result",
                "white_elo", "black_elo", "eco", "opening", "time_control", "ply_count")


def _safe_name(name: str) -> str:
    name = re.sub(r"[^\w\- ]+", "", name).strip()
    if not name:
        raise ValueError("Database name must contain letters or digits")
    return name


def db_path(name: str) -> Path:
    return DB_DIR / f"{_safe_name(name)}.db"


def connect(name: str, create: bool = False) -> sqlite3.Connection:
    path = db_path(name)
    if not create and not path.exists():
        raise FileNotFoundError(f"No database named {name!r}")
    con = sqlite3.connect(path, timeout=30, isolation_level=None, check_same_thread=False)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode=WAL")
    con.executescript(SCHEMA)
    return con


@contextmanager
def opened(name: str, create: bool = False):
    """Autocommit connection that is always closed (open files block deletion on Windows)."""
    con = connect(name, create)
    try:
        yield con
    finally:
        con.close()


def signed_hash(board: chess.Board) -> int:
    h = chess.polyglot.zobrist_hash(board)
    return h - (1 << 64) if h >= (1 << 63) else h


def _int(v: str | None) -> int | None:
    try:
        return int(v) if v else None
    except ValueError:
        return None


# ---------------------------------------------------------------- listing / CRUD

def list_databases() -> list[dict]:
    out = []
    for p in sorted(DB_DIR.glob("*.db")):
        try:
            with opened(p.stem) as con:
                n = con.execute("SELECT COUNT(*) FROM games").fetchone()[0]
                row = con.execute("SELECT value FROM meta WHERE key='description'").fetchone()
        except sqlite3.Error:
            n, row = 0, None
        out.append({"name": p.stem, "games": n, "size": p.stat().st_size,
                    "description": row[0] if row else ""})
    return out


def create_database(name: str, description: str = "") -> dict:
    path = db_path(name)
    if path.exists():
        raise ValueError(f"A database named {name!r} already exists")
    with opened(name, create=True) as con:
        con.execute("INSERT OR REPLACE INTO meta VALUES('description', ?)", (description,))
    return {"name": path.stem, "games": 0, "size": path.stat().st_size, "description": description}


def delete_database(name: str):
    path = db_path(name)
    for suffix in ("", "-wal", "-shm"):
        p = path.with_name(path.name + suffix)
        if p.exists():
            p.unlink()


def search_games(name: str, player: str = "", white: str = "", black: str = "", event: str = "",
                 result: str = "", sort: str = "id", desc: bool = True,
                 offset: int = 0, limit: int = 50) -> dict:
    where, args = [], []
    if player:
        where.append("(white LIKE ? OR black LIKE ?)")
        args += [f"%{player}%", f"%{player}%"]
    if white:
        where.append("white LIKE ?")
        args.append(f"%{white}%")
    if black:
        where.append("black LIKE ?")
        args.append(f"%{black}%")
    if event:
        where.append("event LIKE ?")
        args.append(f"%{event}%")
    if result:
        where.append("result = ?")
        args.append(result)
    clause = ("WHERE " + " AND ".join(where)) if where else ""
    sort = sort if sort in GAME_COLUMNS else "id"
    with opened(name) as con:
        total = con.execute(f"SELECT COUNT(*) FROM games {clause}", args).fetchone()[0]
        rows = con.execute(f"SELECT {', '.join(GAME_COLUMNS)} FROM games {clause} "
                           f"ORDER BY {sort} {'DESC' if desc else 'ASC'} LIMIT ? OFFSET ?",
                           args + [limit, offset]).fetchall()
    return {"total": total, "games": [dict(r) for r in rows]}


def get_game(name: str, game_id: int) -> dict:
    with opened(name) as con:
        row = con.execute("SELECT * FROM games WHERE id=?", (game_id,)).fetchone()
    if row is None:
        raise FileNotFoundError("No such game")
    return dict(row)


def delete_game(name: str, game_id: int):
    with opened(name) as con:
        con.execute("DELETE FROM positions WHERE game_id=?", (game_id,))
        con.execute("DELETE FROM games WHERE id=?", (game_id,))


# ---------------------------------------------------------------- import

def _insert_game(con: sqlite3.Connection, game: chess.pgn.Game) -> int | None:
    h = game.headers
    try:
        board = game.board()
    except ValueError:
        return None
    positions = []
    ply = 0
    for move in game.mainline_moves():
        if ply < MAX_INDEX_PLY:
            positions.append((signed_hash(board), ply, move.uci()))
        board.push(move)
        ply += 1
    if ply < MAX_INDEX_PLY:
        positions.append((signed_hash(board), ply, None))
    pgn = game.accept(chess.pgn.StringExporter(headers=True, variations=True, comments=True))
    cur = con.execute(
        "INSERT INTO games(event, site, date, round, white, black, result, white_elo, black_elo, "
        "eco, opening, time_control, ply_count, pgn) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (h.get("Event"), h.get("Site"), h.get("Date"), h.get("Round"), h.get("White"), h.get("Black"),
         h.get("Result"), _int(h.get("WhiteElo")), _int(h.get("BlackElo")), h.get("ECO"),
         h.get("Opening"), h.get("TimeControl"), ply, pgn))
    gid = cur.lastrowid
    con.executemany("INSERT INTO positions(hash, game_id, ply, move) VALUES(?,?,?,?)",
                    [(hh, gid, p, m) for hh, p, m in positions])
    return gid


def import_pgn(name: str, text: str, progress=None) -> int:
    """Add every game in `text` to the database. Returns the number imported."""
    stream = io.StringIO(text)
    total_bytes = max(1, len(text))
    n = 0
    con = connect(name, create=True)
    try:
        con.execute("BEGIN")
        while True:
            pos = stream.tell()
            try:
                game = chess.pgn.read_game(stream)
            except Exception:
                if stream.tell() == pos:
                    break
                continue
            if game is None:
                break
            if game.errors and not any(True for _ in game.mainline_moves()):
                continue
            if _insert_game(con, game) is not None:
                n += 1
            if n % 250 == 0:
                con.execute("COMMIT")
                con.execute("BEGIN")
                if progress:
                    progress(stream.tell() / total_bytes, f"{n} games imported")
        con.execute("COMMIT")
    finally:
        con.close()
    return n


def add_game(name: str, pgn: str) -> int:
    game = chess.pgn.read_game(io.StringIO(pgn))
    if game is None:
        raise ValueError("Could not read the PGN")
    with opened(name, create=True) as con:
        con.execute("BEGIN")
        gid = _insert_game(con, game)
        con.execute("COMMIT")
    if gid is None:
        raise ValueError("Invalid game")
    return gid


# ---------------------------------------------------------------- downloads

def _http_get(url: str, headers: dict | None = None, timeout: int = 60) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def download_lichess(username: str, max_games: int, token: str | None = None) -> str:
    q = urllib.parse.urlencode({"max": max_games, "clocks": "true", "opening": "true"})
    headers = {"Accept": "application/x-chess-pgn"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return _http_get(f"https://lichess.org/api/games/user/{urllib.parse.quote(username)}?{q}",
                     headers, timeout=300).decode("utf-8", "replace")


def download_chesscom(username: str, max_games: int, progress=None) -> str:
    archives = json.loads(_http_get(
        f"https://api.chess.com/pub/player/{urllib.parse.quote(username.lower())}/games/archives"))["archives"]
    chunks, count = [], 0
    for i, url in enumerate(reversed(archives)):  # newest month first
        text = _http_get(url + "/pgn").decode("utf-8", "replace")
        games = [g for g in re.split(r"\n\s*\n(?=\[Event )", text) if g.strip()]
        games.reverse()
        take = games[: max_games - count]
        chunks.extend(take)
        count += len(take)
        if progress:
            progress(min(count / max_games, 0.99) * 0.5, f"downloaded {count} games")
        if count >= max_games:
            break
    return "\n\n".join(reversed(chunks))


# ---------------------------------------------------------------- explorer

def explore(name: str, fen: str, limit_games: int = 12) -> dict:
    board = chess.Board(fen)
    h = signed_hash(board)
    with opened(name) as con:
        rows = con.execute(
            "SELECT p.move AS move, COUNT(*) AS n, "
            "SUM(g.result='1-0') AS w, SUM(g.result='1/2-1/2') AS d, SUM(g.result='0-1') AS b "
            "FROM positions p JOIN games g ON g.id=p.game_id WHERE p.hash=? "
            "GROUP BY p.move ORDER BY n DESC", (h,)).fetchall()
        games = con.execute(
            f"SELECT DISTINCT {', '.join('g.' + c for c in GAME_COLUMNS)} FROM positions p "
            "JOIN games g ON g.id=p.game_id WHERE p.hash=? "
            "ORDER BY COALESCE(g.white_elo,0)+COALESCE(g.black_elo,0) DESC LIMIT ?",
            (h, limit_games)).fetchall()
    moves, tw, td, tb = [], 0, 0, 0
    for r in rows:
        tw, td, tb = tw + (r["w"] or 0), td + (r["d"] or 0), tb + (r["b"] or 0)
        if r["move"] is None:
            continue
        mv = chess.Move.from_uci(r["move"])
        if not board.is_legal(mv):  # hash collision, practically impossible
            continue
        moves.append({"uci": r["move"], "san": board.san(mv), "games": r["n"],
                      "white": r["w"] or 0, "draws": r["d"] or 0, "black": r["b"] or 0})
    return {"total": sum(r["n"] for r in rows), "white": tw, "draws": td, "black": tb,
            "moves": moves, "games": [dict(g) for g in games]}


# ---------------------------------------------------------------- background jobs

_jobs: dict[str, dict] = {}
_jobs_lock = threading.Lock()


def start_job(label: str, fn) -> str:
    """Run fn(progress) in a thread; progress(fraction, message)."""
    jid = uuid.uuid4().hex[:10]
    job = {"id": jid, "label": label, "progress": 0.0, "message": "starting", "done": False,
           "error": None, "result": None, "started": time.time()}
    with _jobs_lock:
        _jobs[jid] = job

    def progress(frac: float, msg: str):
        job.update(progress=round(float(frac), 3), message=msg)

    def run():
        try:
            job["result"] = fn(progress)
            job.update(progress=1.0, message="done")
        except Exception as ex:
            job["error"] = f"{type(ex).__name__}: {ex}"
        finally:
            job["done"] = True

    threading.Thread(target=run, daemon=True, name=f"job-{jid}").start()
    return jid


def get_job(jid: str) -> dict:
    with _jobs_lock:
        job = _jobs.get(jid)
    if job is None:
        raise FileNotFoundError("No such job")
    return dict(job)
