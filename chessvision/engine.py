"""Ask a UCI engine (Stockfish) for the top N moves via MultiPV."""
from __future__ import annotations

import os
import shutil
from dataclasses import dataclass

import chess
import chess.engine


@dataclass
class Candidate:
    move: chess.Move
    san: str
    score: chess.engine.PovScore
    pv_san: list[str]
    depth: int = 0

    def eval_text(self) -> str:
        """Evaluation from White's point of view, Lichess style (+1.25, #3, #-2)."""
        s = self.score.white()
        if s.is_mate():
            return f"#{s.mate()}"
        return f"{s.score() / 100:+.2f}"


def find_engine(explicit: str | None = None) -> str:
    for cand in (explicit, os.environ.get("STOCKFISH_PATH"), shutil.which("stockfish"),
                 shutil.which("stockfish.exe")):
        if cand and os.path.isfile(cand):
            return cand
    raise FileNotFoundError(
        "Stockfish not found. Download it from https://stockfishchess.org/download/ and pass "
        "--engine PATH, set STOCKFISH_PATH, or put 'stockfish' on your PATH.")


def top_moves(board: chess.Board, engine_path: str, n: int = 3,
              seconds: float = 1.0, depth: int | None = None, threads: int = 2) -> list[Candidate]:
    """Top-n moves from the deepest iteration in which *all* n lines completed.

    With a time limit the search usually stops mid-iteration, so the latest
    line per rank can come from different depths (line 2 may show a better
    score than line 1). Grouping by depth keeps the ranking consistent.
    """
    n = min(n, board.legal_moves.count())
    limit = chess.engine.Limit(depth=depth) if depth else chess.engine.Limit(time=seconds)
    by_depth: dict[int, dict[int, dict]] = {}
    with chess.engine.SimpleEngine.popen_uci(engine_path) as eng:
        eng.configure({"Threads": threads})
        with eng.analysis(board, limit, multipv=n) as analysis:
            for info in analysis:
                if not {"pv", "score", "depth"} <= info.keys():
                    continue
                if info.get("lowerbound") or info.get("upperbound"):
                    continue
                by_depth.setdefault(info["depth"], {})[info.get("multipv", 1)] = info
    if not by_depth:
        return []
    complete = [d for d, lines in by_depth.items() if len(lines) >= n]
    best_depth = max(complete) if complete else max(by_depth)
    infos = [by_depth[best_depth][k] for k in sorted(by_depth[best_depth])]
    out = []
    for info in infos:
        pv = info.get("pv")
        if not pv:
            continue
        b = board.copy()
        pv_san = []
        for mv in pv[:8]:
            pv_san.append(b.san(mv))
            b.push(mv)
        out.append(Candidate(move=pv[0], san=pv_san[0], score=info["score"], pv_san=pv_san,
                             depth=best_depth))
    return out
