"""Follow a game while it is being played on Lichess and relay it to the UI.

Each watch runs in its own thread and reads one of the Lichess streaming
endpoints. Whatever the source, the UI receives the same few messages:

  live_game   {headers, initialFen, moves: [uci], clocks: [seconds | None]}   full state
  live_move   {uci, clock}                                                  one more move
  live_status {state: connecting | live | reconnecting}
  live_end    {result, reason}
  live_error  {message}

The game stream sends positions (FEN + last move) and replays the whole game
on every connection, so moves are reconciled on a python-chess board: a
position already known is skipped, a new one is reached by looking up the
legal move that leads to it (which also normalises castling notation).
"""
from __future__ import annotations

import http.client
import io
import json
import queue
import re
import socket
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Callable

import chess
import chess.pgn

from .games_db import USER_AGENT

Send = Callable[[dict], None]

READ_TIMEOUT = 120  # seconds without a byte (Lichess sends keep-alive newlines) -> reconnect
_ID = r"[A-Za-z0-9]{8}"
_RESULT_END = re.compile(r"(\*|1-0|0-1|1/2-1/2)\s*$")

STATUS_TEXT = {
    "mate": "Checkmate", "resign": "Resignation", "stalemate": "Stalemate", "timeout": "Opponent left",
    "draw": "Draw", "outoftime": "Time out", "cheat": "Cheat detected", "noStart": "Game not started",
    "variantEnd": "Variant ending", "insufficientMaterialClaim": "Insufficient material", "aborted": "Game aborted",
}


class LiveError(Exception):
    """A problem that reconnecting will not fix (bad link, game not found)."""


# ---------------------------------------------------------------- links

def parse_source(text: str) -> dict:
    """Lichess link (or bare game id) -> {kind: game|broadcast|tv, ...}."""
    s = (text or "").strip()
    if not s:
        raise ValueError("Paste a Lichess game, broadcast or TV link")
    if re.fullmatch(f"{_ID}([A-Za-z0-9]{{4}})?", s):
        return {"kind": "game", "id": s[:8]}
    u = urllib.parse.urlparse(s if "://" in s else "https://" + s)
    if not (u.netloc == "lichess.org" or u.netloc.endswith(".lichess.org")):
        raise ValueError("Only lichess.org links can be followed. For other sites, use screen capture.")
    parts = [p for p in u.path.split("/") if p]
    if parts and parts[0] == "tv":
        return {"kind": "tv", "channel": parts[1] if len(parts) > 1 else None}
    if parts and parts[0] == "broadcast":
        rest = parts[1:]  # tour-slug / round-slug / roundId [/ gameId]   or   tour-slug / tourId
        if len(rest) >= 3:
            return {"kind": "broadcast", "tour": None, "round": rest[2], "game": rest[3] if len(rest) > 3 else None}
        if len(rest) == 2:
            return {"kind": "broadcast", "tour": rest[1], "round": None, "game": None}
    if parts and parts[0] == "embed":
        parts = parts[1:]
    if parts and re.fullmatch(f"{_ID}([A-Za-z0-9]{{4}})?", parts[0]):
        return {"kind": "game", "id": parts[0][:8]}
    raise ValueError("Not a Lichess game, broadcast or TV link")


def _request(url: str, token: str | None, accept: str) -> urllib.request.Request:
    headers = {"User-Agent": USER_AGENT, "Accept": accept}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return urllib.request.Request(url, headers=headers)


def _get_json(url: str, token: str | None = None) -> Any:
    try:
        with urllib.request.urlopen(_request(url, token, "application/json"), timeout=20) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        if e.code == 404:
            raise LiveError("Not found on Lichess")
        raise


def resolve(text: str, token: str | None = None) -> dict:
    """Parse a link; for broadcasts also find the round and list its games."""
    src = parse_source(text)
    if src["kind"] != "broadcast":
        return src
    if not src["round"]:
        tour = _get_json(f"https://lichess.org/api/broadcast/{src['tour']}", token)
        src["round"] = tour.get("defaultRoundId") or (tour.get("rounds") or [{}])[0].get("id")
        if not src["round"]:
            raise LiveError("This broadcast has no rounds yet")
    data = _get_json(f"https://lichess.org/api/broadcast/-/-/{src['round']}", token)
    src["roundName"] = data.get("round", {}).get("name", "")
    src["tourName"] = data.get("tour", {}).get("name", "")
    src["games"] = [{
        "id": g["id"], "name": g.get("name", ""), "status": g.get("status", "*"),
        "fen": g.get("fen"), "lastMove": g.get("lastMove"),
        "players": [{"name": p.get("name"), "title": p.get("title"), "rating": p.get("rating")}
                    for p in g.get("players", [])],
    } for g in data.get("games", [])]
    return src


def _key(fen: str) -> str:
    """Placement + side to move: enough to tell positions of one game apart."""
    return " ".join(fen.split()[:2])


def _result_of(game: dict) -> tuple[str, str]:
    winner = game.get("winner")
    status = (game.get("status") or {}).get("name", "")
    result = {"white": "1-0", "black": "0-1"}.get(winner, "*" if status in ("aborted", "noStart") else "1/2-1/2")
    reason = STATUS_TEXT.get(status, status)
    if winner:
        reason = f"{winner.capitalize()} wins: {reason.lower()}"
    return result, reason


def _game_headers(game: dict) -> dict:
    h = {"Event": f"{'Rated' if game.get('rated') else 'Casual'} {game.get('speed', '')} game".replace("  ", " "),
         "Site": f"https://lichess.org/{game['id']}", "Result": "*"}
    if game.get("createdAt"):
        h["Date"] = time.strftime("%Y.%m.%d", time.gmtime(game["createdAt"] / 1000))
    for color, tag in (("white", "White"), ("black", "Black")):
        p = (game.get("players") or {}).get(color) or {}
        user = p.get("user") or {}
        h[tag] = user.get("name") or (f"Stockfish level {p['aiLevel']}" if p.get("aiLevel") else "Anonymous")
        if p.get("rating"):
            h[f"{tag}Elo"] = str(p["rating"])
        if user.get("title"):
            h[f"{tag}Title"] = user["title"]
    return h


# ---------------------------------------------------------------- watch

_IDLE, _EOF = object(), object()


class _Resync(Exception):
    """The stream no longer matches what was sent: start over from a fresh snapshot."""


class LiveWatch:
    def __init__(self, key: str, req: dict, send: Send):
        self.key, self._send = key, send
        self.url = req.get("url", "")
        self.round, self.game_id = req.get("round"), req.get("game")
        self.token = req.get("token") or None
        self.cancelled = False
        self._resp = None
        self._reset()
        threading.Thread(target=self._run, daemon=True, name=f"live-{key}").start()

    def cancel(self):
        self.cancelled = True
        resp = self._resp
        if resp is not None:  # unblock the reader thread
            try:
                resp.fp.raw._sock.shutdown(socket.SHUT_RDWR)
            except Exception:
                pass

    # -- plumbing

    def send(self, kind: str, **fields):
        if not self.cancelled:
            self._send({"type": kind, "id": self.key, **fields})

    def _reset(self):
        self.board: chess.Board | None = None
        self.keys: list[str] = []          # position key per ply, from the start position
        self.clocks: list[float | None] = []
        self.headers: dict = {}
        self.sent: list[str] = []          # broadcast: moves already sent

    def _open(self, url: str, accept: str = "application/x-ndjson"):
        try:
            self._resp = urllib.request.urlopen(_request(url, self.token, accept), timeout=READ_TIMEOUT)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                raise LiveError("Not found on Lichess. Check the link.")
            raise
        return self._resp

    def _lines(self, resp, idle: float = 0.5):
        """Lines of a streaming response; yields _IDLE when nothing arrived for `idle` seconds."""
        q: queue.Queue = queue.Queue()

        def reader():
            try:
                for raw in resp:
                    q.put(raw.decode("utf-8", "replace").rstrip("\r\n"))
                    if self.cancelled:
                        break
            except Exception as ex:
                q.put(ex)
            q.put(_EOF)

        threading.Thread(target=reader, daemon=True, name=f"live-read-{self.key}").start()
        while not self.cancelled:
            try:
                item = q.get(timeout=idle)
            except queue.Empty:
                yield _IDLE
                continue
            if item is _EOF:
                return
            if isinstance(item, Exception):
                raise item
            yield item

    def _sleep(self, seconds: float):
        end = time.monotonic() + seconds
        while not self.cancelled and time.monotonic() < end:
            time.sleep(0.25)

    def _run(self):
        delay = 2.0
        self.send("live_status", state="connecting")
        while not self.cancelled:
            try:
                src = parse_source(self.url)
                if src["kind"] == "game":
                    done = self._follow_game(src["id"])
                elif src["kind"] == "tv":
                    done = self._follow_tv(src.get("channel"))
                else:
                    done = self._follow_broadcast(src)
                if done:
                    return
                delay = 2.0
            except _Resync:
                self._reset()
                self._sleep(1)
                continue
            except urllib.error.HTTPError as ex:
                if ex.code == 429:  # rate limited: Lichess asks for a minute's pause
                    delay = 60.0
            except (OSError, http.client.HTTPException, json.JSONDecodeError):
                pass  # network trouble or a line cut short: reconnect
            except (LiveError, ValueError) as ex:
                self.send("live_error", message=str(ex))
                return
            if self.cancelled:
                return
            self.send("live_status", state="reconnecting")
            self._sleep(delay)
            delay = min(30.0, delay * 2)

    # -- games and TV

    def _snapshot(self):
        assert self.board is not None
        self.send("live_game", headers=self.headers, initialFen=self.board.root().fen(),
                  moves=[m.uci() for m in self.board.move_stack], clocks=self.clocks[1:])
        self.send("live_status", state="live")

    def _position(self, fen: str, clock: dict, quiet: bool, replay: list[int]):
        """One position from the game stream. `replay[0]` = known plies matched on this connection."""
        k = _key(fen)
        if replay[0] < len(self.keys):
            if self.keys[replay[0]] == k:
                replay[0] += 1
                return
            raise _Resync()
        if self.board is None:
            self.board = chess.Board(fen)
            self.keys, self.clocks = [k], [None]
            replay[0] = 1
            return
        placement, turn = k.split()
        move = next((m for m in self.board.legal_moves if self._leads_to(m, placement, turn)), None)
        if move is None:
            raise _Resync()
        mover = self.board.turn
        self.board.push(move)
        self.keys.append(k)
        replay[0] = len(self.keys)
        secs = clock.get("wc" if mover == chess.WHITE else "bc")
        self.clocks.append(float(secs) if secs is not None else None)
        if not quiet:
            self.send("live_move", uci=move.uci(), clock=self.clocks[-1])

    def _leads_to(self, move: chess.Move, placement: str, turn: str) -> bool:
        self.board.push(move)
        ok = self.board.board_fen() == placement and ("w" if self.board.turn else "b") == turn
        self.board.pop()
        return ok

    def _follow_game(self, gid: str) -> bool:
        """Stream one game until it ends. True when it finished, False to reconnect."""
        with self._open(f"https://lichess.org/api/stream/game/{gid}") as resp:
            replay = [0]
            # The stream first replays the game so far in one burst: collect it and
            # send it as a single snapshot once the burst is over.
            snapshot = self.board is None
            if not snapshot:
                self.send("live_status", state="live")
            for line in self._lines(resp):
                if line is _IDLE:
                    if snapshot and self.board is not None:
                        snapshot = False
                        self._snapshot()
                    continue
                if not line.strip():
                    continue
                msg = json.loads(line)
                if "id" in msg:  # game description: first line, and again once the game is over
                    if (msg.get("variant") or {}).get("key", "standard") not in ("standard", "fromPosition"):
                        raise LiveError("Only standard chess can be followed, not variants")
                    self.headers = {**self.headers, **_game_headers(msg)}
                    status = (msg.get("status") or {}).get("name")
                    if status and status not in ("created", "started"):
                        if snapshot and self.board is not None:
                            self._snapshot()
                        result, reason = _result_of(msg)
                        self.send("live_end", result=result, reason=reason)
                        return True
                elif "fen" in msg:
                    self._position(msg["fen"], msg, snapshot, replay)
        return False

    def _follow_tv(self, channel: str | None) -> bool:
        """Follow a TV channel: its current game, then the next one, and so on."""
        want = (channel or "best").replace("-", "").lower()
        last = None
        while not self.cancelled:
            channels = _get_json("https://lichess.org/api/tv/channels", self.token)
            entry = next((v for k, v in channels.items() if k.lower() == want), None)
            if entry is None:
                raise LiveError(f"Unknown Lichess TV channel '{channel}'")
            gid = entry.get("gameId")
            if not gid or gid == last:
                self._sleep(3)  # the channel has not moved on to a new game yet
                continue
            last = gid
            self._reset()
            while not self.cancelled:
                try:
                    if self._follow_game(gid):
                        break
                except _Resync:
                    self._reset()
                    self._sleep(1)
            self._sleep(4)  # leave the final position on screen for a moment
        return True

    # -- broadcasts

    def _follow_broadcast(self, src: dict) -> bool:
        round_id = self.round or src.get("round")
        game_id = self.game_id or src.get("game")
        if not round_id or not game_id:
            resolved = resolve(self.url, self.token)
            round_id = round_id or resolved["round"]
            if not game_id:
                raise LiveError("Pick one of the broadcast's games")
        self.round, self.game_id = round_id, game_id
        with self._open(f"https://lichess.org/api/stream/broadcast/round/{round_id}.pgn",
                        "application/x-chess-pgn") as resp:
            buf: list[str] = []
            for line in self._lines(resp, idle=1.0):
                if line is _IDLE:
                    continue
                buf.append(line)
                # every update is a complete PGN; its movetext ends with the result
                if line.strip() and not line.startswith("[") and _RESULT_END.search(line):
                    text, buf = "\n".join(buf), []
                    if self._broadcast_pgn(text, game_id):
                        return True
        return False

    def _broadcast_pgn(self, text: str, game_id: str) -> bool:
        game = chess.pgn.read_game(io.StringIO(text))
        if game is None:
            return False
        url = game.headers.get("GameURL") or game.headers.get("Site", "")
        if not url.rstrip("/").endswith("/" + game_id):
            return False
        headers = {k: v for k, v in game.headers.items() if k not in ("GameURL", "BroadcastURL")}
        nodes = list(game.mainline())
        moves = [n.move.uci() for n in nodes]
        clocks = [n.clock() for n in nodes]
        start = game.board().fen()
        if self.board is None or self.board.fen() != start or moves[:len(self.sent)] != self.sent:
            self.board = chess.Board(start)
            self.send("live_game", headers=headers, initialFen=start, moves=moves, clocks=clocks)
            self.send("live_status", state="live")
        else:
            for uci, clk in zip(moves[len(self.sent):], clocks[len(self.sent):]):
                self.send("live_move", uci=uci, clock=clk)
        self.sent = moves
        result = headers.get("Result", "*")
        if result != "*":
            self.send("live_end", result=result, reason="Game over")
            return True
        return False
