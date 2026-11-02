import { Chess, normalizeMove, IllegalSetup } from "chessops/chess";
import { INITIAL_FEN, makeFen, parseFen } from "chessops/fen";
import { makeSan, parseSan } from "chessops/san";
import { chessgroundDests } from "chessops/compat";
import { makeSquare, parseSquare, parseUci, squareFile, squareRank } from "chessops/util";
import type { Move, NormalMove, Role } from "chessops/types";
import type { Key } from "chessground/types";

export { INITIAL_FEN };
export type Color = "white" | "black";

export function posFromFen(fen: string): Chess {
  return Chess.fromSetup(parseFen(fen).unwrap()).unwrap();
}

export function tryPos(fen: string): Chess | null {
  const setup = parseFen(fen);
  if (setup.isErr) return null;
  const pos = Chess.fromSetup(setup.value);
  return pos.isOk ? pos.value : null;
}

const SETUP_ERRORS: Record<string, string> = {
  [IllegalSetup.Empty]: "The board is empty",
  [IllegalSetup.OppositeCheck]: "The side not to move is in check",
  [IllegalSetup.PawnsOnBackrank]: "Pawns on the first or last rank",
  [IllegalSetup.Kings]: "Each side needs exactly one king",
  [IllegalSetup.Variant]: "Not a standard chess position",
};

/** null when the FEN is a legal position, otherwise a readable reason. */
export function fenError(fen: string): string | null {
  const setup = parseFen(fen);
  if (setup.isErr) return "Invalid FEN";
  const pos = Chess.fromSetup(setup.value);
  if (pos.isErr) return SETUP_ERRORS[pos.error.message] ?? pos.error.message;
  return null;
}

export const fenOf = (pos: Chess) => makeFen(pos.toSetup());

/** Parse a UCI string in standard notation (e1g1 castles) into a move playable in `pos`. */
export function moveFromUci(pos: Chess, uci: string): Move | null {
  const move = parseUci(uci);
  if (!move) return null;
  const norm = normalizeMove(pos, move);
  return pos.isLegal(norm) ? norm : null;
}

/** Standard UCI for a move: castling written as the king's two-square jump. */
export function stdUci(pos: Chess, move: Move): string {
  const m = move as NormalMove;
  let to = m.to;
  const piece = pos.board.get(m.from);
  const target = pos.board.get(m.to);
  if (piece?.role === "king" && target?.role === "rook" && target.color === piece.color) {
    to = (squareFile(m.to) > squareFile(m.from) ? 6 : 2) + 8 * squareRank(m.from);
  }
  return makeSquare(m.from) + makeSquare(to) + (m.promotion ? roleChar(m.promotion) : "");
}

const roleChar = (r: Role) => ({ pawn: "p", knight: "n", bishop: "b", rook: "r", queen: "q", king: "k" })[r];

export interface Played {
  uci: string;
  san: string;
  fen: string;
  capture: boolean;
  check: boolean;
}

/** Play a UCI move from a FEN; null if illegal. */
export function playUci(fen: string, uci: string): Played | null {
  const pos = tryPos(fen);
  if (!pos) return null;
  const move = moveFromUci(pos, uci);
  if (!move) return null;
  const m = move as NormalMove;
  const capture = !!pos.board.get(m.to) && pos.board.get(m.to)!.color !== pos.turn || isEnPassant(pos, m);
  const san = makeSan(pos, move);
  const std = stdUci(pos, move);
  pos.play(move);
  return { uci: std, san, fen: fenOf(pos), capture, check: pos.isCheck() };
}

function isEnPassant(pos: Chess, m: NormalMove) {
  return pos.board.get(m.from)?.role === "pawn" && pos.epSquare === m.to;
}

export function sanToUci(fen: string, san: string): string | null {
  const pos = tryPos(fen);
  if (!pos) return null;
  const move = parseSan(pos, san);
  return move ? stdUci(pos, move) : null;
}

/** Play a list of UCI moves, returning SAN for each (stops at the first illegal one). */
export function uciLineToSan(fen: string, ucis: string[]): string[] {
  const out: string[] = [];
  let cur = fen;
  for (const u of ucis) {
    const p = playUci(cur, u);
    if (!p) break;
    out.push(p.san);
    cur = p.fen;
  }
  return out;
}

export function dests(pos: Chess): Map<Key, Key[]> {
  return chessgroundDests(pos) as Map<Key, Key[]>;
}

export function turnOf(fen: string): Color {
  return fen.split(" ")[1] === "b" ? "black" : "white";
}

export function plyOf(fen: string): number {
  const parts = fen.split(" ");
  const full = parseInt(parts[5] || "1", 10) || 1;
  return (full - 1) * 2 + (parts[1] === "b" ? 1 : 0);
}

export function checkColor(fen: string): Color | false {
  const pos = tryPos(fen);
  return pos && pos.isCheck() ? pos.turn : false;
}

/** "1-0", "0-1", "1/2-1/2" or null; `reason` explains why. */
export function gameOutcome(fen: string): { result: string; reason: string } | null {
  const pos = tryPos(fen);
  if (!pos) return null;
  if (pos.isCheckmate()) return { result: pos.turn === "white" ? "0-1" : "1-0", reason: "Checkmate" };
  if (pos.isStalemate()) return { result: "1/2-1/2", reason: "Stalemate" };
  if (pos.isInsufficientMaterial()) return { result: "1/2-1/2", reason: "Insufficient material" };
  if (pos.halfmoves >= 100) return { result: "1/2-1/2", reason: "Fifty-move rule" };
  return null;
}

/** FEN without move counters, for repetition detection. */
export const positionKey = (fen: string) => fen.split(" ").slice(0, 4).join(" ");

export function uciSquares(uci: string): [Key, Key] {
  return [uci.slice(0, 2) as Key, uci.slice(2, 4) as Key];
}

export function isPromotion(fen: string, orig: string, dest: string): boolean {
  const pos = tryPos(fen);
  if (!pos) return false;
  const from = parseSquare(orig);
  const piece = from !== undefined ? pos.board.get(from) : undefined;
  return piece?.role === "pawn" && (dest[1] === "8" || dest[1] === "1");
}

export function boardFen(fen: string) {
  return fen.split(" ")[0];
}

/** Material difference per side, for the captured-pieces strip. */
export function materialDiff(fen: string): Record<Color, Partial<Record<Role, number>>> & { score: number } {
  const counts: Record<string, number> = {};
  for (const ch of boardFen(fen)) if (/[pnbrqkPNBRQK]/.test(ch)) counts[ch] = (counts[ch] || 0) + 1;
  const roles: [Role, string, number][] = [["queen", "q", 9], ["rook", "r", 5], ["bishop", "b", 3], ["knight", "n", 3], ["pawn", "p", 1]];
  const white: Partial<Record<Role, number>> = {};
  const black: Partial<Record<Role, number>> = {};
  let score = 0;
  for (const [role, c, v] of roles) {
    const d = (counts[c.toUpperCase()] || 0) - (counts[c] || 0);
    if (d > 0) white[role] = d;
    if (d < 0) black[role] = -d;
    score += d * v;
  }
  return { white, black, score };
}
