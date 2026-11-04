"""Open what a Lichess link shows: a finished (or ongoing) game, a study, the analysis board or a puzzle.

load() answers with either {pgn, orientation, ply} or {fen, orientation}:
`orientation` is the side at the bottom when the link says so (".../black",
"?color=black"), `ply` the move the link points at ("#34"); both may be None.
"""
from __future__ import annotations

import io
import json
import re
import urllib.error
import urllib.parse

import chess
import chess.pgn

from .games_db import _http_get

_ID = r"[A-Za-z0-9]{8}"
VARIANTS = {"chess960", "crazyhouse", "antichess", "atomic", "horde", "kingOfTheHill", "racingKings", "threeCheck"}


def parse_link(text: str) -> dict:
    """Lichess link -> {kind: game|study|analysis|puzzle, ...}."""
    s = (text or "").strip()
    if re.fullmatch(f"{_ID}([A-Za-z0-9]{{4}})?", s):
        return {"kind": "game", "id": s[:8], "color": None, "ply": None}
    u = urllib.parse.urlparse(s if "://" in s else "https://" + s)
    host = u.netloc.lower()
    if host == "chess.com" or host.endswith(".chess.com"):
        raise ValueError("Chess.com games cannot be opened from a link. Use screen capture under Watch a live game instead.")
    if not (host == "lichess.org" or host.endswith(".lichess.org")):
        raise ValueError("Not a Lichess link")
    parts = [urllib.parse.unquote(p) for p in u.path.split("/") if p]
    query = urllib.parse.parse_qs(u.query)
    color = query.get("color", [None])[0]
    color = color if color in ("white", "black") else None
    ply = int(u.fragment) if u.fragment.isdigit() else None

    if parts[:1] == ["study"] and len(parts) >= 2 and re.fullmatch(_ID, parts[1]):
        chapter = parts[2] if len(parts) > 2 and re.fullmatch(_ID, parts[2]) else None
        return {"kind": "study", "id": parts[1], "chapter": chapter}
    if parts[:1] == ["analysis"]:
        rest = parts[1:]
        if rest and rest[0] in VARIANTS:
            raise ValueError("Only standard chess can be opened, not variants")
        if rest and rest[0] in ("standard", "fromPosition"):
            rest = rest[1:]
        fen = "/".join(rest).replace("_", " ").strip() or chess.STARTING_FEN
        try:
            fen = chess.Board(fen).fen()
        except ValueError:
            raise ValueError("The position in this analysis link cannot be read")
        return {"kind": "analysis", "fen": fen, "color": color}
    if parts[:1] == ["training"] and len(parts) == 2 and re.fullmatch(r"[A-Za-z0-9]{5}", parts[1]):
        return {"kind": "puzzle", "id": parts[1]}
    if parts[:2] == ["embed", "game"]:
        parts = parts[2:]
    elif parts[:1] == ["embed"]:
        parts = parts[1:]
    if parts and re.fullmatch(f"{_ID}([A-Za-z0-9]{{4}})?", parts[0]):
        side = parts[1] if len(parts) > 1 and parts[1] in ("white", "black") else None
        return {"kind": "game", "id": parts[0][:8], "color": side or color, "ply": ply}
    raise ValueError("Not a link to a Lichess game, study, analysis board or puzzle")


def _get(url: str, token: str | None, accept: str, missing: str) -> bytes:
    headers = {"Accept": accept}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    try:
        return _http_get(url, headers, timeout=30)
    except urllib.error.HTTPError as ex:
        if ex.code in (403, 404):
            raise LookupError(missing)
        raise


def _puzzle_pgn(data: dict) -> tuple[str, str, int]:
    """Puzzle JSON -> (PGN of the game up to the puzzle, then the solution; orientation; ply of the puzzle)."""
    game, puzzle = data["game"], data["puzzle"]
    pgn = chess.pgn.read_game(io.StringIO(game["pgn"]))
    if pgn is None:
        raise ValueError("The puzzle's game cannot be read")
    players = {p.get("color"): p.get("name", "?") for p in game.get("players", [])}
    pgn.headers.update({"Event": f"Lichess puzzle {puzzle['id']}", "Site": f"https://lichess.org/training/{puzzle['id']}",
                        "White": players.get("white", "?"), "Black": players.get("black", "?")})
    node = pgn.end()
    start = node.board()
    for i, uci in enumerate(puzzle.get("solution", [])):
        node = node.add_main_variation(chess.Move.from_uci(uci))
        if i == 0:
            node.comment = f"Puzzle solution (rated {puzzle.get('rating', '?')})"
    exporter = chess.pgn.StringExporter(headers=True, variations=True, comments=True)
    return pgn.accept(exporter), "white" if start.turn == chess.WHITE else "black", start.ply()


def load(text: str, token: str | None = None) -> dict:
    link = parse_link(text)
    kind = link["kind"]
    if kind == "analysis":
        return {"fen": link["fen"], "orientation": link["color"]}
    if kind == "puzzle":
        raw = _get(f"https://lichess.org/api/puzzle/{link['id']}", token, "application/json", "Puzzle not found")
        pgn, orientation, ply = _puzzle_pgn(json.loads(raw))
        return {"pgn": pgn, "orientation": orientation, "ply": ply}
    if kind == "study":
        path = f"{link['id']}/{link['chapter']}" if link["chapter"] else link["id"]
        q = urllib.parse.urlencode({"clocks": "true", "comments": "true", "variations": "true"})
        raw = _get(f"https://lichess.org/api/study/{path}.pgn?{q}", token, "application/x-chess-pgn",
                   "Study not found. If it is private, add a Lichess token in Settings.")
        return {"pgn": raw.decode("utf-8", "replace"), "orientation": None, "ply": None}
    q = urllib.parse.urlencode({"clocks": "true", "evals": "false"})
    pgn = _get(f"https://lichess.org/game/export/{link['id']}?{q}", token, "application/x-chess-pgn",
               "Game not found").decode("utf-8", "replace")
    variant = re.search(r'^\[Variant "([^"]*)"\]', pgn, re.M)
    if variant and variant.group(1) not in ("Standard", "From Position"):
        raise ValueError(f"Only standard chess can be opened, not {variant.group(1)}")
    return {"pgn": pgn, "orientation": link["color"], "ply": link["ply"]}
