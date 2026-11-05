"""UCI engines for the UI: a persisted registry, live analysis sessions,
full-game reports, position-by-position evaluation of live games and single
best-move requests for play mode.

python-chess's SimpleEngine runs its own event loop in a background thread,
so everything here is plain threads; results are handed to the websocket via
a thread-safe `send` callback.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import threading
import time
import uuid
from collections import deque
from dataclasses import dataclass
from typing import Any, Callable

import chess
import chess.engine

from chessvision.engine import find_engine

from .paths import DATA

ENGINES_FILE = DATA / "engines.json"
Send = Callable[[dict], None]


# ---------------------------------------------------------------- registry

def _probe(path: str) -> dict:
    """Start the engine once to read its name and UCI options."""
    with chess.engine.SimpleEngine.popen_uci(path) as eng:
        opts = {}
        for name, o in eng.options.items():
            if o.is_managed():
                continue
            opts[name] = {"type": o.type, "default": o.default, "min": o.min, "max": o.max,
                          "var": list(o.var or [])}
        return {"name": eng.id.get("name", os.path.basename(path)),
                "author": eng.id.get("author", ""), "options": opts}


class EngineRegistry:
    def __init__(self):
        self._lock = threading.Lock()
        self._engines: list[dict] = []
        if ENGINES_FILE.exists():
            try:
                self._engines = json.loads(ENGINES_FILE.read_text("utf-8"))
            except (OSError, ValueError):
                self._engines = []
        try:
            builtin = find_engine()
        except FileNotFoundError:
            builtin = None
        self._engines = [e for e in self._engines if not e.get("builtin")]
        if builtin:
            self._engines.insert(0, {"id": "stockfish", "name": "Stockfish", "path": builtin,
                                     "builtin": True, "options": None})

    def _save(self):
        ENGINES_FILE.write_text(json.dumps([e for e in self._engines if not e.get("builtin")],
                                           indent=2), "utf-8")

    def list(self) -> list[dict]:
        with self._lock:
            pending = [e for e in self._engines if e.get("options") is None]
        for e in pending:  # probe lazily so start-up stays fast
            try:
                info = _probe(e["path"])
                e.update(options=info["options"], name=info["name"] if e.get("builtin") else e["name"],
                         author=info["author"])
            except Exception as ex:  # broken path etc. - still list it
                e.update(options={}, error=str(ex))
        with self._lock:
            return [dict(e) for e in self._engines]

    def add(self, path: str, name: str | None = None) -> dict:
        path = path.strip().strip('"')
        if not os.path.isfile(path):
            raise ValueError(f"No file at {path}")
        info = _probe(path)
        entry = {"id": uuid.uuid4().hex[:8], "name": name or info["name"], "path": path,
                 "builtin": False, "author": info["author"], "options": info["options"]}
        with self._lock:
            self._engines.append(entry)
            self._save()
        return entry

    def remove(self, engine_id: str):
        with self._lock:
            self._engines = [e for e in self._engines if e["id"] != engine_id or e.get("builtin")]
            self._save()

    def path(self, engine_id: str) -> str:
        with self._lock:
            for e in self._engines:
                if e["id"] == engine_id:
                    return e["path"]
            if self._engines:  # unknown id (e.g. removed engine still in a saved tab)
                return self._engines[0]["path"]
        raise FileNotFoundError("No UCI engine configured. Add one on the Engines page.")


registry = EngineRegistry()


# ---------------------------------------------------------------- helpers

def background_engine(path: str) -> chess.engine.SimpleEngine:
    """An engine that uses whatever CPU is left: it must never hold up the board, the page or the
    picture being read. On a machine that is otherwise idle it runs as fast as ever."""
    if os.name == "nt":
        return chess.engine.SimpleEngine.popen_uci(path, creationflags=subprocess.BELOW_NORMAL_PRIORITY_CLASS)
    return chess.engine.SimpleEngine.popen_uci(["nice", "-n", "5", path] if shutil.which("nice") else path)


def score_json(score: chess.engine.PovScore) -> dict:
    s = score.white()
    if s.is_mate():
        return {"mate": s.mate()}
    return {"cp": s.score()}


def board_from(fen: str | None, moves: list[str] | None) -> chess.Board:
    board = chess.Board(fen) if fen else chess.Board()
    for uci in moves or []:
        board.push_uci(uci)
    return board


def pv_san(board: chess.Board, pv: list[chess.Move], limit: int = 16) -> list[str]:
    b = board.copy(stack=False)
    out = []
    for mv in pv[:limit]:
        if not b.is_legal(mv):
            break
        out.append(b.san(mv))
        b.push(mv)
    return out


def make_limit(spec: dict | None) -> chess.engine.Limit | None:
    """{type: infinite|depth|time|nodes, value} -> Limit (None = analyse until stopped)."""
    spec = spec or {}
    kind, value = spec.get("type", "infinite"), spec.get("value")
    if kind == "depth" and value:
        return chess.engine.Limit(depth=int(value))
    if kind == "time" and value:
        return chess.engine.Limit(time=float(value))
    if kind == "nodes" and value:
        return chess.engine.Limit(nodes=int(value))
    return None


def configure(eng: chess.engine.SimpleEngine, settings: dict, applied: dict):
    """Apply Threads/Hash/custom options that changed since last time."""
    want: dict[str, Any] = {}
    for name, value in (settings.get("options") or {}).items():
        want[name] = value
    if settings.get("threads"):
        want["Threads"] = int(settings["threads"])
    if settings.get("hash"):
        want["Hash"] = int(settings["hash"])
    changes = {}
    for name, value in want.items():
        opt = eng.options.get(name)
        if opt is None or opt.is_managed() or applied.get(name) == value:
            continue
        changes[name] = value
    if changes:
        eng.configure(changes)
        applied.update(changes)


# ---------------------------------------------------------------- live analysis

_NONE, _STOP, _CLOSE = object(), object(), object()


class AnalysisSession:
    """One engine process analysing whatever position the client asked for last.

    `request()` never blocks: it records the newest request and interrupts the
    running search; a control thread picks up only the latest one, so rapid
    navigation through a game does not queue up stale searches.
    """

    def __init__(self, key: str, engine_id: str, send: Send):
        self.key, self.engine_id, self.send = key, engine_id, send
        self.engine: chess.engine.SimpleEngine | None = None
        self.applied: dict = {}
        self.current: chess.engine.SimpleAnalysisResult | None = None
        self.pending: Any = _NONE
        self.cv = threading.Condition()
        threading.Thread(target=self._loop, daemon=True, name=f"analysis-{key}").start()

    def request(self, req: Any):
        with self.cv:
            self.pending = req
            if self.current is not None:
                self.current.stop()
            self.cv.notify()

    def stop(self):
        self.request(_STOP)

    def close(self):
        self.request(_CLOSE)

    def _loop(self):
        while True:
            with self.cv:
                while self.pending is _NONE:
                    self.cv.wait()
                req, self.pending = self.pending, _NONE
            if req is _CLOSE:
                break
            if req is _STOP:
                continue
            try:
                self._analyse(req)
            except Exception as ex:  # engine died, bad FEN, ...
                self.send({"type": "error", "id": self.key, "token": req.get("token"),
                           "message": f"{type(ex).__name__}: {ex}"})
                self._quit()
        self._quit()

    def _quit(self):
        if self.engine is not None:
            try:
                self.engine.quit()
            except Exception:
                try:
                    self.engine.close()
                except Exception:
                    pass
        self.engine = None
        self.applied = {}

    def _analyse(self, req: dict):
        token = req.get("token")
        board = board_from(req.get("fen"), req.get("moves"))
        base = {"type": "analysis", "id": self.key, "token": token, "engine": self.engine_id}
        if board.is_game_over(claim_draw=False):
            self.send({**base, "done": True, "gameOver": board.result(claim_draw=False), "lines": []})
            return
        if self.engine is None:
            self.engine = background_engine(registry.path(self.engine_id))
        configure(self.engine, req, self.applied)
        multipv = max(1, min(int(req.get("multipv", 1)), board.legal_moves.count()))
        lines: dict[int, dict] = {}
        stats: dict[str, Any] = {}
        last_sent = 0.0

        def emit(done: bool):
            ordered = [{**lines[k], "pv": [m.uci() for m in lines[k]["pv"]], "san": pv_san(board, lines[k]["pv"])}
                       for k in sorted(lines)]
            self.send({**base, **stats, "done": done, "lines": ordered})

        with self.engine.analysis(board, make_limit(req.get("limit")), multipv=multipv) as an:
            with self.cv:
                self.current = an
                if self.pending is not _NONE:
                    an.stop()
            try:
                for info in an:
                    for k in ("depth", "seldepth", "nodes", "nps", "time", "hashfull", "tbhits"):
                        if k in info:
                            stats[k] = info[k]
                    if info.get("pv") and "score" in info and not (info.get("lowerbound") or info.get("upperbound")):
                        lines[info.get("multipv", 1)] = {
                            "multipv": info.get("multipv", 1), "depth": info.get("depth", 0),
                            "score": score_json(info["score"]), "pv": info["pv"]}
                    now = time.monotonic()
                    if lines and now - last_sent > 0.25:
                        emit(False)
                        last_sent = now
            finally:
                with self.cv:
                    self.current = None
        if lines:
            emit(True)


def evaluate(eng: chess.engine.SimpleEngine, board: chess.Board, limit: chess.engine.Limit,
             game: object = None) -> dict:
    """Score (White's view), best move and line of one position, plus the score
    of the second-best move; game-over positions need no search."""
    outcome = board.outcome(claim_draw=False)
    if outcome is not None:
        if outcome.winner is None:
            return {"score": {"cp": 0}}
        return {"score": {"mate": 0, "winner": "white" if outcome.winner else "black"}}
    infos = eng.analyse(board, limit, multipv=2, game=game)
    info = infos[0]
    out: dict[str, Any] = {"score": score_json(info["score"])}
    pv = info.get("pv") or []
    if pv:
        out["best"] = pv[0].uci()
        out["pv"] = [m.uci() for m in pv[:10]]
        out["san"] = pv_san(board, pv, 10)
    if len(infos) > 1 and "score" in infos[1]:
        out["second"] = score_json(infos[1]["score"])
    return out


# ---------------------------------------------------------------- game report

class ReportJob:
    """Evaluate every position of a line, one after another, streaming results."""

    def __init__(self, key: str, req: dict, send: Send):
        self.key, self.req, self.send = key, req, send
        self.cancelled = False
        threading.Thread(target=self._run, daemon=True, name=f"report-{key}").start()

    def cancel(self):
        self.cancelled = True

    def _run(self):
        req = self.req
        try:
            board = board_from(req.get("fen"), [])
            moves = [chess.Move.from_uci(u) for u in req.get("moves", [])]
            limit = make_limit(req.get("limit")) or chess.engine.Limit(depth=16)
            total = len(moves) + 1
            with background_engine(registry.path(req.get("engine", "stockfish"))) as eng:
                configure(eng, req, {})
                for i in range(total):
                    if self.cancelled:
                        return
                    self.send({"type": "report_progress", "id": self.key, "index": i, "total": total,
                               **evaluate(eng, board, limit, game=self)})
                    if i < len(moves):
                        board.push(moves[i])
            self.send({"type": "report_done", "id": self.key})
        except Exception as ex:
            self.send({"type": "report_error", "id": self.key, "message": f"{type(ex).__name__}: {ex}"})


# ---------------------------------------------------------------- live games

class EvalQueue:
    """Evaluate positions of a live game, keeping one engine open.

    The newest position goes first, as it is the one on the board; older ones are
    then filled in from the start of the game whenever nothing newer is waiting.
    Runs beside the tab's AnalysisSession, so the engine lines on the current
    move are never interrupted by the per-move evaluations.
    """

    def __init__(self, key: str, send: Send):
        self.key, self.send = key, send
        self.queue: deque[dict] = deque()
        self.newest_waiting = False
        self.cancelled = False
        self.cv = threading.Condition()
        threading.Thread(target=self._run, daemon=True, name=f"eval-{key}").start()

    def request(self, req: dict):
        with self.cv:
            self.queue.append(req)
            self.newest_waiting = True
            self.cv.notify()

    def clear(self):
        """Forget what has not started, keeping the engine: the game on the board has changed."""
        with self.cv:
            self.queue.clear()

    def cancel(self):
        with self.cv:
            self.cancelled = True
            self.queue.clear()
            self.cv.notify()

    def _run(self):
        engine: chess.engine.SimpleEngine | None = None
        engine_id, applied = None, {}
        try:
            while True:
                with self.cv:
                    while not self.queue and not self.cancelled:
                        self.cv.wait()
                    if self.cancelled:
                        return
                    req = self.queue.pop() if self.newest_waiting else self.queue.popleft()
                    self.newest_waiting = False
                tag = req.get("tag")
                try:
                    eid = req.get("engine", "stockfish")
                    if engine is None or eid != engine_id:
                        if engine is not None:
                            engine.quit()
                        engine = background_engine(registry.path(eid))
                        engine_id, applied = eid, {}
                    configure(engine, req, applied)
                    board = board_from(req.get("fen"), req.get("moves"))
                    res = evaluate(engine, board, make_limit(req.get("limit")) or chess.engine.Limit(depth=14), game=self)
                    if not self.cancelled:
                        self.send({"type": "eval_result", "id": self.key, "tag": tag, "root": req.get("fen"), **res})
                except Exception as ex:  # engine died, illegal move list, ...
                    self.send({"type": "eval_error", "id": self.key, "tag": tag, "message": f"{type(ex).__name__}: {ex}"})
                    if engine is not None:
                        try:
                            engine.close()
                        except Exception:
                            pass
                    engine = None
        finally:
            if engine is not None:
                try:
                    engine.quit()
                except Exception:
                    pass


# ---------------------------------------------------------------- play mode

@dataclass
class _Pooled:
    engine: chess.engine.SimpleEngine
    lock: threading.Lock


_pool: dict[str, _Pooled] = {}
_pool_lock = threading.Lock()

# Lichess-like AI levels: (Skill Level, depth, think time in seconds)
LEVELS = {1: (0, 1, 0.05), 2: (3, 2, 0.1), 3: (6, 4, 0.15), 4: (9, 6, 0.2),
          5: (12, 8, 0.3), 6: (15, 12, 0.5), 7: (18, 16, 1.0), 8: (20, 22, 2.0)}


def best_move(req: dict) -> dict:
    """One move for play mode. Engine processes are pooled per engine id."""
    engine_id = req.get("engine", "stockfish")
    with _pool_lock:
        pooled = _pool.get(engine_id)
        if pooled is None:
            pooled = _Pooled(chess.engine.SimpleEngine.popen_uci(registry.path(engine_id)), threading.Lock())
            _pool[engine_id] = pooled
    board = board_from(req.get("fen"), req.get("moves"))
    if board.is_game_over():
        return {"uci": None}
    level = int(req.get("level", 8))
    skill, depth, seconds = LEVELS.get(level, LEVELS[8])
    options = {}
    if "Skill Level" in pooled.engine.options:
        options["Skill Level"] = skill
    clock = req.get("clock")
    if clock:  # real clocks: let the engine manage its own time, capped by the level
        limit = chess.engine.Limit(white_clock=clock["wtime"] / 1000, black_clock=clock["btime"] / 1000,
                                   white_inc=clock.get("winc", 0) / 1000, black_inc=clock.get("binc", 0) / 1000,
                                   depth=depth if level < 8 else None)
    else:
        limit = chess.engine.Limit(depth=depth, time=seconds)
    with pooled.lock:
        try:
            result = pooled.engine.play(board, limit, options=options)
        except chess.engine.EngineTerminatedError:
            with _pool_lock:
                _pool.pop(engine_id, None)
            raise
    mv = result.move
    return {"uci": mv.uci() if mv else None, "san": board.san(mv) if mv else None}


def shutdown():
    with _pool_lock:
        for p in _pool.values():
            try:
                p.engine.quit()
            except Exception:
                pass
        _pool.clear()
