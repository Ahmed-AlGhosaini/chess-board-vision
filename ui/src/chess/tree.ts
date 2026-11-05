import { boardFen, INITIAL_FEN, playUci, plyOf, positionKey, turnOf } from "./position";
import type { Score } from "./eval";

export interface Shape {
  orig: string;
  dest?: string;
  brush: string;
}

export interface TreeNode {
  id: string;
  parent: string | null;
  children: string[]; // children[0] continues the main line
  ply: number;
  fen: string;
  uci?: string;
  san?: string;
  comment?: string;
  nags?: number[];
  shapes?: Shape[];
  clock?: number; // seconds left after this move ([%clk])
  score?: Score; // stored engine evaluation of this position (game report)
  best?: string; // engine's best move from this position, UCI (game report)
  second?: Score; // score of the engine's second-best move (game report)
}

export interface GameState {
  nodes: Record<string, TreeNode>;
  root: string;
  cursor: string;
  headers: Record<string, string>;
}

let counter = 0;
const newId = () => `${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 5)}`;

export function newGame(fen: string = INITIAL_FEN, headers: Record<string, string> = {}): GameState {
  const root: TreeNode = { id: "root", parent: null, children: [], ply: plyOf(fen), fen };
  const h: Record<string, string> = { Event: "?", Site: "?", Date: "????.??.??", White: "?", Black: "?", Result: "*", ...headers };
  if (fen !== INITIAL_FEN) {
    h.FEN = fen;
    h.SetUp = "1";
  }
  return { nodes: { root }, root: "root", cursor: "root", headers: h };
}

export const rootFen = (g: GameState) => g.nodes[g.root].fen;
export const current = (g: GameState) => g.nodes[g.cursor];

/** Node ids from the root (inclusive) to `id` (inclusive). */
export function pathTo(g: GameState, id: string): string[] {
  const out: string[] = [];
  for (let n: TreeNode | undefined = g.nodes[id]; n; n = n.parent ? g.nodes[n.parent] : undefined) out.push(n.id);
  return out.reverse();
}

/** UCI moves from the root to `id`. */
export function movesTo(g: GameState, id: string): string[] {
  return pathTo(g, id).slice(1).map((nid) => g.nodes[nid].uci!);
}

/** Main line ids starting at `from` (inclusive). */
export function mainline(g: GameState, from: string = g.root): string[] {
  const out = [from];
  let n = g.nodes[from];
  while (n.children.length) {
    n = g.nodes[n.children[0]];
    out.push(n.id);
  }
  return out;
}

export function isOnMainline(g: GameState, id: string): boolean {
  let n = g.nodes[id];
  while (n.parent) {
    const p = g.nodes[n.parent];
    if (p.children[0] !== n.id) return false;
    n = p;
  }
  return true;
}

/** Add a move after `parentId` (or reuse the existing child). Returns the new state and child id. */
export function addMove(g: GameState, uci: string, parentId: string = g.cursor, extra: Partial<TreeNode> = {}):
  { game: GameState; id: string; capture: boolean; check: boolean } | null {
  const parent = g.nodes[parentId];
  const existing = parent.children.find((c) => g.nodes[c].uci === uci);
  if (existing) {
    const p = playUci(parent.fen, uci);
    return { game: { ...g, cursor: existing }, id: existing, capture: !!p?.capture, check: !!p?.check };
  }
  const played = playUci(parent.fen, uci);
  if (!played) return null;
  // Engine/PGN may give e1h1-style castling: if that normalises to an existing child, reuse it.
  const dup = parent.children.find((c) => g.nodes[c].uci === played.uci);
  if (dup) return { game: { ...g, cursor: dup }, id: dup, capture: played.capture, check: played.check };
  const id = newId();
  const node: TreeNode = { id, parent: parentId, children: [], ply: parent.ply + 1, fen: played.fen, uci: played.uci, san: played.san, ...extra };
  const nodes = { ...g.nodes, [id]: node, [parentId]: { ...parent, children: [...parent.children, id] } };
  return { game: { ...g, nodes, cursor: id }, id, capture: played.capture, check: played.check };
}

/** Add a sequence of UCI moves after `parentId`, moving the cursor to the last one. */
export function addLine(g: GameState, ucis: string[], parentId: string = g.cursor): GameState {
  let game = g;
  let at = parentId;
  for (const u of ucis) {
    const r = addMove(game, u, at);
    if (!r) break;
    game = r.game;
    at = r.id;
  }
  return game;
}

export function deleteNode(g: GameState, id: string): GameState {
  const node = g.nodes[id];
  if (!node.parent) return g;
  const nodes = { ...g.nodes };
  const drop = (nid: string) => {
    for (const c of nodes[nid].children) drop(c);
    delete nodes[nid];
  };
  drop(id);
  const parent = nodes[node.parent];
  nodes[node.parent] = { ...parent, children: parent.children.filter((c) => c !== id) };
  const cursor = nodes[g.cursor] ? g.cursor : node.parent;
  return { ...g, nodes, cursor };
}

/** Delete every move after `id` (keep the node itself). */
export function truncateAfter(g: GameState, id: string): GameState {
  let game = g;
  for (const c of [...g.nodes[id].children]) game = deleteNode(game, c);
  return game;
}

/** Move the branch containing `id` one step towards the main line. */
export function promoteVariation(g: GameState, id: string, toMain = false): GameState {
  const nodes = { ...g.nodes };
  let n = nodes[id];
  while (n.parent) {
    const p = nodes[n.parent];
    const idx = p.children.indexOf(n.id);
    if (idx > 0) {
      const children = [...p.children];
      children.splice(idx, 1);
      children.unshift(n.id);
      nodes[p.id] = { ...p, children };
      if (!toMain) break;
    }
    n = nodes[p.id];
  }
  return { ...g, nodes };
}

export function updateNode(g: GameState, id: string, patch: Partial<TreeNode>): GameState {
  return { ...g, nodes: { ...g.nodes, [id]: { ...g.nodes[id], ...patch } } };
}

export function toggleNag(g: GameState, id: string, nag: number, exclusiveGroup: number[] = []): GameState {
  const node = g.nodes[id];
  const nags = node.nags ?? [];
  const next = nags.includes(nag) ? nags.filter((x) => x !== nag) : [...nags.filter((x) => !exclusiveGroup.includes(x)), nag];
  return updateNode(g, id, { nags: next });
}

// ------------------------------------------------------------ navigation

export function goTo(g: GameState, id: string): GameState {
  return g.nodes[id] ? { ...g, cursor: id } : g;
}

export function goNext(g: GameState): GameState {
  const n = current(g);
  return n.children.length ? { ...g, cursor: n.children[0] } : g;
}

export function goPrev(g: GameState): GameState {
  const n = current(g);
  return n.parent ? { ...g, cursor: n.parent } : g;
}

export const goStart = (g: GameState): GameState => ({ ...g, cursor: g.root });

export function goEnd(g: GameState): GameState {
  const line = mainline(g, g.cursor);
  return { ...g, cursor: line[line.length - 1] };
}

/** Switch to the previous/next sibling variation at the current move. */
export function goSibling(g: GameState, dir: 1 | -1): GameState {
  const n = current(g);
  if (!n.parent) return g;
  const sibs = g.nodes[n.parent].children;
  const i = sibs.indexOf(n.id);
  const j = (i + dir + sibs.length) % sibs.length;
  return { ...g, cursor: sibs[j] };
}

/** The node showing this position, closest to `near`. The side to move on a watched board is only a
 * guess, so the placement alone counts if nothing matches fully. */
export function knownNode(g: GameState, fen: string, near: string = g.cursor): string | undefined {
  const here = g.nodes[near];
  const placement = boardFen(fen);
  const same = Object.values(g.nodes).filter((n) => boardFen(n.fen) === placement)
    .sort((a, b) => Math.abs(a.ply - here.ply) - Math.abs(b.ply - here.ply));
  return (same.find((n) => turnOf(n.fen) === turnOf(fen)) ?? same[0])?.id;
}

/** Threefold repetition along the path to `id`. */
export function isThreefold(g: GameState, id: string): boolean {
  const keys = pathTo(g, id).map((nid) => positionKey(g.nodes[nid].fen));
  const last = keys[keys.length - 1];
  return keys.filter((k) => k === last).length >= 3;
}

/** Copy of the game re-rooted at `id` (that position becomes the start). */
export function gameFrom(g: GameState, id: string): GameState {
  const fresh = newGame(g.nodes[id].fen, { ...g.headers, Result: "*" });
  const copy = (src: string, dst: string, game: GameState): GameState => {
    let out = game;
    for (const c of g.nodes[src].children) {
      const r = addMove(out, g.nodes[c].uci!, dst, pick(g.nodes[c]));
      if (!r) continue;
      out = copy(c, r.id, r.game);
    }
    return out;
  };
  return { ...copy(id, fresh.root, fresh), cursor: fresh.root };
}

const pick = (n: TreeNode): Partial<TreeNode> => ({ comment: n.comment, nags: n.nags, shapes: n.shapes, clock: n.clock });
