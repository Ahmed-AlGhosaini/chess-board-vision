/** Engine scores, always from White's point of view. */
export interface Score {
  cp?: number;
  mate?: number;
  /** set when the position is already checkmate (mate === 0) */
  winner?: "white" | "black";
}

/** Lichess win-probability model, 0..100 for White. */
export function winPct(s: Score | undefined): number {
  if (!s) return 50;
  if (s.mate !== undefined) {
    if (s.mate === 0) return s.winner === "black" ? 0 : 100;
    return s.mate > 0 ? 100 : 0;
  }
  const cp = Math.max(-1000, Math.min(1000, s.cp ?? 0));
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
}

export function formatScore(s: Score | undefined): string {
  if (!s) return "";
  if (s.mate !== undefined) {
    if (s.mate === 0) return s.winner === "black" ? "0-1" : "1-0";
    return s.mate > 0 ? `#${s.mate}` : `#-${-s.mate}`;
  }
  const v = (s.cp ?? 0) / 100;
  return (v > 0 ? "+" : "") + v.toFixed(2);
}

/** Eval bar fill for White, 0..1. */
export const barFraction = (s: Score | undefined) => winPct(s) / 100;

/** Number for charts: pawns, clamped to ±10, mates pinned to the edge. */
export function chartValue(s: Score | undefined): number | null {
  if (!s) return null;
  if (s.mate !== undefined) {
    if (s.mate === 0) return s.winner === "black" ? -10 : 10;
    return s.mate > 0 ? 10 : -10;
  }
  return Math.max(-10, Math.min(10, (s.cp ?? 0) / 100));
}

export type MoveClass = "best" | "excellent" | "good" | "inaccuracy" | "mistake" | "blunder";

export const NAG_FOR_CLASS: Partial<Record<MoveClass, number>> = { inaccuracy: 6, mistake: 2, blunder: 4 };

/** Classify by the drop in the mover's winning chances (Lichess thresholds). */
export function classifyMove(before: Score, after: Score, moverIsWhite: boolean, isBest: boolean): MoveClass {
  const drop = moverIsWhite ? winPct(before) - winPct(after) : winPct(after) - winPct(before);
  if (isBest) return "best";
  if (drop >= 30) return "blunder";
  if (drop >= 20) return "mistake";
  if (drop >= 10) return "inaccuracy";
  if (drop >= 2) return "good";
  return "excellent";
}

/** Per-move accuracy from the mover's win% before and after (Lichess formula). */
export function moveAccuracy(winBefore: number, winAfter: number): number {
  if (winAfter >= winBefore) return 100;
  const acc = 103.1668 * Math.exp(-0.04354 * (winBefore - winAfter)) - 3.1669;
  return Math.max(0, Math.min(100, acc + 1));
}

/**
 * Game accuracy for both sides, following Lichess: the mean of a
 * volatility-weighted mean and a harmonic mean of per-move accuracies.
 */
export function gameAccuracy(scores: Score[], startsWhite: boolean): { white: number; black: number } {
  const wins = scores.map(winPct);
  const n = wins.length - 1;
  if (n < 1) return { white: 100, black: 100 };
  const window = Math.max(2, Math.min(8, Math.floor(n / 10)));
  const weights: number[] = [];
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, Math.min(i - Math.floor(window / 2), wins.length - window));
    const slice = wins.slice(lo, lo + window);
    const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
    const sd = Math.sqrt(slice.reduce((a, b) => a + (b - mean) ** 2, 0) / slice.length);
    weights.push(Math.max(0.5, Math.min(12, sd)));
  }
  const per: Record<"white" | "black", { acc: number; w: number }[]> = { white: [], black: [] };
  for (let i = 0; i < n; i++) {
    const whiteMoved = (i % 2 === 0) === startsWhite;
    const before = whiteMoved ? wins[i] : 100 - wins[i];
    const after = whiteMoved ? wins[i + 1] : 100 - wins[i + 1];
    per[whiteMoved ? "white" : "black"].push({ acc: moveAccuracy(before, after), w: weights[i] });
  }
  const summarise = (xs: { acc: number; w: number }[]) => {
    if (!xs.length) return 100;
    const weighted = xs.reduce((a, x) => a + x.acc * x.w, 0) / xs.reduce((a, x) => a + x.w, 0);
    const harmonic = xs.length / xs.reduce((a, x) => a + 1 / Math.max(x.acc, 1), 0);
    return (weighted + harmonic) / 2;
  };
  return { white: summarise(per.white), black: summarise(per.black) };
}

/** Average centipawn loss for each side (mates capped at ±10 pawns). */
export function averageCpl(scores: Score[], startsWhite: boolean): { white: number; black: number } {
  const cp = (s: Score) => (chartValue(s) ?? 0) * 100;
  const tot = { white: 0, black: 0 };
  const cnt = { white: 0, black: 0 };
  for (let i = 0; i + 1 < scores.length; i++) {
    const whiteMoved = (i % 2 === 0) === startsWhite;
    const loss = whiteMoved ? cp(scores[i]) - cp(scores[i + 1]) : cp(scores[i + 1]) - cp(scores[i]);
    const side = whiteMoved ? "white" : "black";
    tot[side] += Math.max(0, loss);
    cnt[side]++;
  }
  return { white: cnt.white ? tot.white / cnt.white : 0, black: cnt.black ? tot.black / cnt.black : 0 };
}

export const NAGS: { nag: number; symbol: string; label: string; color?: string }[] = [
  { nag: 3, symbol: "!!", label: "Brilliant", color: "#26c2a3" },
  { nag: 1, symbol: "!", label: "Good move", color: "#5c8bb0" },
  { nag: 5, symbol: "!?", label: "Interesting", color: "#ea45d8" },
  { nag: 6, symbol: "?!", label: "Dubious / inaccuracy", color: "#e6b800" },
  { nag: 2, symbol: "?", label: "Mistake", color: "#e69d00" },
  { nag: 4, symbol: "??", label: "Blunder", color: "#df5353" },
  { nag: 7, symbol: "□", label: "Only move" },
  { nag: 22, symbol: "⨀", label: "Zugzwang" },
  { nag: 10, symbol: "=", label: "Equal position" },
  { nag: 13, symbol: "∞", label: "Unclear" },
  { nag: 14, symbol: "⩲", label: "White is slightly better" },
  { nag: 15, symbol: "⩱", label: "Black is slightly better" },
  { nag: 16, symbol: "±", label: "White is better" },
  { nag: 17, symbol: "∓", label: "Black is better" },
  { nag: 18, symbol: "+−", label: "White is winning" },
  { nag: 19, symbol: "−+", label: "Black is winning" },
  { nag: 146, symbol: "N", label: "Novelty" },
  { nag: 32, symbol: "⟳", label: "Development" },
  { nag: 36, symbol: "→", label: "Initiative" },
  { nag: 40, symbol: "↑", label: "Attack" },
  { nag: 132, symbol: "⇆", label: "Counterplay" },
  { nag: 138, symbol: "⊕", label: "Time trouble" },
];

export const MOVE_NAGS = [1, 2, 3, 4, 5, 6, 7];
export const nagInfo = (nag: number) => NAGS.find((n) => n.nag === nag);
