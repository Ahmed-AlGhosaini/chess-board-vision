import { makeFen } from "chessops/fen";
import { makeComment, parseComment, parsePgn, startingPosition, type Node, type PgnNodeData } from "chessops/pgn";
import { makeSquare, parseSquare } from "chessops/util";
import type { CommentShape, CommentShapeColor, Evaluation } from "chessops/pgn";
import { sanToUci } from "./position";
import { addMove, newGame, type GameState, type Shape, type TreeNode } from "./tree";
import type { Score } from "./eval";

const BRUSHES: CommentShapeColor[] = ["green", "red", "yellow", "blue"];

function toShapes(shapes: CommentShape[]): Shape[] {
  return shapes.map((s) => ({
    orig: makeSquare(s.from),
    dest: s.from === s.to ? undefined : makeSquare(s.to),
    brush: s.color,
  }));
}

function fromShapes(shapes: Shape[] | undefined): CommentShape[] {
  return (shapes ?? []).flatMap((s) => {
    const from = parseSquare(s.orig);
    const to = s.dest ? parseSquare(s.dest) : from;
    const color = (BRUSHES as string[]).includes(s.brush) ? (s.brush as CommentShapeColor) : "green";
    return from === undefined || to === undefined ? [] : [{ from, to, color }];
  });
}

const evalToScore = (e: Evaluation | undefined): Score | undefined =>
  !e ? undefined : "mate" in e ? { mate: e.mate } : { cp: Math.round(e.pawns * 100) };

const scoreToEval = (s: Score | undefined): Evaluation | undefined =>
  !s || (s.mate === 0) ? undefined : s.mate !== undefined ? { mate: s.mate } : { pawns: (s.cp ?? 0) / 100 };

/** Every game in a PGN text. Games that cannot be read are skipped. */
export function parsePgnText(text: string): GameState[] {
  const out: GameState[] = [];
  for (const game of parsePgn(text)) {
    const start = startingPosition(game.headers);
    if (start.isErr) continue;
    const fen = makeFen(start.value.toSetup());
    let state = newGame(fen, Object.fromEntries(game.headers));
    if (game.comments?.length) {
      const c = parseComment(game.comments.join(" "));
      state.nodes.root = { ...state.nodes.root, comment: c.text.trim() || undefined, shapes: toShapes(c.shapes) };
    }
    const walk = (pgnNode: Node<PgnNodeData>, parentId: string) => {
      for (const child of pgnNode.children) {
        const uci = sanToUci(state.nodes[parentId].fen, child.data.san);
        if (!uci) continue;
        const c = parseComment((child.data.comments ?? []).join(" "));
        const extra: Partial<TreeNode> = {};
        if (c.text.trim()) extra.comment = c.text.trim();
        if (c.shapes.length) extra.shapes = toShapes(c.shapes);
        if (c.clock !== undefined) extra.clock = c.clock;
        if (c.evaluation) extra.score = evalToScore(c.evaluation);
        if (child.data.nags?.length) extra.nags = child.data.nags;
        const r = addMove(state, uci, parentId, extra);
        if (!r) continue;
        state = r.game;
        walk(child, r.id);
      }
    };
    walk(game.moves, state.root);
    out.push({ ...state, cursor: state.root });
  }
  return out;
}

const ROSTER = ["Event", "Site", "Date", "Round", "White", "Black", "Result"];

function commentOf(n: TreeNode, withEvals: boolean): string {
  const shapes = fromShapes(n.shapes);
  const evaluation = withEvals ? scoreToEval(n.score) : undefined;
  if (!n.comment && !shapes.length && n.clock === undefined && !evaluation) return "";
  return `{ ${makeComment({ text: n.comment ?? "", shapes, clock: n.clock, evaluation })} }`;
}

function moveToken(n: TreeNode, forceNumber: boolean): string {
  const moverPly = n.ply - 1;
  const num = Math.floor(moverPly / 2) + 1;
  const prefix = moverPly % 2 === 0 ? `${num}. ` : forceNumber ? `${num}... ` : "";
  const nags = (n.nags ?? []).map((x) => ` $${x}`).join("");
  return `${prefix}${n.san}${nags}`;
}

export function toPgn(g: GameState, opts: { variations?: boolean; comments?: boolean; evals?: boolean } = {}): string {
  const { variations = true, comments = true, evals = false } = opts;
  const lines: string[] = [];
  const keys = [...ROSTER, ...Object.keys(g.headers).filter((k) => !ROSTER.includes(k))];
  for (const k of keys) {
    const v = g.headers[k] ?? (k === "Result" ? "*" : "?");
    lines.push(`[${k} "${String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]`);
  }
  const tokens: string[] = [];
  const pushComment = (n: TreeNode) => {
    if (!comments) return false;
    const c = commentOf(n, evals);
    if (c) tokens.push(c);
    return !!c;
  };
  const write = (parentId: string, forceNumber: boolean) => {
    const parent = g.nodes[parentId];
    if (!parent.children.length) return;
    const [main, ...vars] = parent.children;
    tokens.push(moveToken(g.nodes[main], forceNumber));
    const commented = pushComment(g.nodes[main]);
    const shownVars = variations ? vars : [];
    for (const v of shownVars) {
      tokens.push("(" + moveToken(g.nodes[v], true));
      const vc = pushComment(g.nodes[v]);
      write(v, vc);
      tokens.push(")");
    }
    write(main, commented || shownVars.length > 0);
  };
  pushComment(g.nodes[g.root]);
  write(g.root, true);
  tokens.push(g.headers.Result || "*");
  // wrap at ~80 columns; "(" and ")" hug their neighbours
  const text = tokens.join(" ").replace(/\( /g, "(").replace(/ \)/g, ")");
  const wrapped: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line && line.length + word.length + 1 > 80) {
      wrapped.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) wrapped.push(line);
  return `${lines.join("\n")}\n\n${wrapped.join("\n")}\n`;
}

export function looksLikeFen(text: string): boolean {
  return /^\s*([pnbrqkPNBRQK1-8]+\/){7}[pnbrqkPNBRQK1-8]+(\s+[wb](\s+(-|[KQkqA-Ha-h]+)(\s+(-|[a-h][36])(\s+\d+\s+\d+)?)?)?)?\s*$/.test(text);
}

/** Complete a partial FEN (board only, or without counters). */
export function completeFen(text: string): string {
  const parts = text.trim().split(/\s+/);
  const defaults = ["", "w", "-", "-", "0", "1"];
  return defaults.map((d, i) => parts[i] ?? d).join(" ");
}
