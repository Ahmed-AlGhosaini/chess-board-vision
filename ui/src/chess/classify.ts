import type { Chess } from "chessops/chess";
import type { NormalMove, Role } from "chessops/types";
import { SquareSet } from "chessops/squareSet";
import { classifyMove, winPct, type MoveClass, type Score } from "./eval";
import { moveFromUci, tryPos, turnOf } from "./position";

/** What the engine said about the position a move was played from. */
export interface PositionEval {
  score: Score;
  best?: string;
  /** score of the second-best move; absent when there is only one legal move */
  second?: Score;
}

const VALUE: Record<Role, number> = { pawn: 1, knight: 3, bishop: 3, rook: 5, queen: 9, king: 0 };
const SEARCH_PLIES = 6;
/** Giving up at least this much (a minor for a pawn, the exchange) counts as a sacrifice; pawns do not. */
const SACRIFICE = 2;
/** The mover's win% must stay this high after a sacrifice. */
const SOUND_WIN = 40;
/** A sacrifice is no brilliancy when another move wins this comfortably anyway. */
const ALREADY_WON = 90;
/** Win% the next-best move gives away for the best one to count as the only good move. */
const ONLY_MOVE_GAP = 20;

const BACK_RANKS = SquareSet.backranks();

/** Material the side to move can win with its best sequence of captures. */
function captureGain(pos: Chess, plies: number): number {
  if (plies === 0) return 0;
  let best = 0; // capturing is optional
  for (const [from, tos] of pos.allDests()) {
    const promotes = pos.board.get(from)?.role === "pawn";
    for (const to of tos) {
      const victim = pos.board.get(to);
      if (!victim || victim.color === pos.turn) continue;
      const promotion = promotes && BACK_RANKS.has(to);
      const next = pos.clone();
      next.play({ from, to, promotion: promotion ? "queen" : undefined });
      best = Math.max(best, VALUE[victim.role] + (promotion ? VALUE.queen - VALUE.pawn : 0) - captureGain(next, plies - 1));
    }
  }
  return best;
}

interface MoveTraits {
  /** gives up material that was not already being lost */
  sacrifice: boolean;
  /** not a capture, promotion, check evasion or rescue of an attacked piece: nothing forced it */
  unforced: boolean;
}

const NO_TRAITS: MoveTraits = { sacrifice: false, unforced: false };

function moveTraits(fen: string, uci: string): MoveTraits {
  const pos = tryPos(fen);
  const move = pos && moveFromUci(pos, uci);
  // in check the opponent's threats cannot be measured, and the reply is forced anyway
  if (!pos || !move || pos.isCheck()) return NO_TRAITS;
  const m = move as NormalMove;
  const victim = pos.board.get(m.to);
  const enPassant = pos.board.get(m.from)?.role === "pawn" && pos.epSquare === m.to;
  const capture = (!!victim && victim.color !== pos.turn) || enPassant;
  const gained = !capture ? 0 : victim ? VALUE[victim.role] : VALUE.pawn;

  // what the opponent could already win if it were their turn: moving away
  // from a fork or giving up a trapped piece is damage control, not a sacrifice
  const passed = pos.clone();
  passed.turn = pos.turn === "white" ? "black" : "white";
  passed.epSquare = undefined;
  const threatened = captureGain(passed, SEARCH_PLIES);

  const after = pos.clone();
  after.play(m);
  const lost = captureGain(after, SEARCH_PLIES) - gained;
  return { sacrifice: lost - threatened >= SACRIFICE, unforced: !capture && !m.promotion && threatened < SACRIFICE };
}

// the live report reclassifies its whole main line on every evaluation
const traitsCache = new Map<string, MoveTraits>();

function cachedTraits(fen: string, uci: string): MoveTraits {
  const key = `${fen} ${uci}`;
  let traits = traitsCache.get(key);
  if (!traits) {
    if (traitsCache.size >= 5000) traitsCache.clear();
    traits = moveTraits(fen, uci);
    traitsCache.set(key, traits);
  }
  return traits;
}

/**
 * Class of the move `uci` played from `fen`: the win% drop decides the base
 * class; a sound, needed sacrifice is brilliant and an unforced only-good move
 * is great.
 */
export function classifyPlayed(fen: string, uci: string, before: PositionEval, after: Score): MoveClass {
  const white = turnOf(fen) === "white";
  const isBest = before.best === uci;
  const base = classifyMove(before.score, after, white, isBest);
  if (base !== "best" && base !== "excellent") return base;

  const win = (s: Score) => (white ? winPct(s) : 100 - winPct(s));
  const worthSacrificing = win(after) >= SOUND_WIN && win(before.second ?? before.score) <= ALREADY_WON;
  const onlyMove = isBest && !!before.second && win(before.score) - win(before.second) >= ONLY_MOVE_GAP && after.mate !== 0;
  if (!worthSacrificing && !onlyMove) return base;

  const traits = cachedTraits(fen, uci);
  if (worthSacrificing && traits.sacrifice) return "brilliant";
  if (onlyMove && traits.unforced) return "great";
  return base;
}
