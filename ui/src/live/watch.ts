import { classifyPlayed } from "../chess/classify";
import { averageCpl, gameAccuracy, type MoveClass } from "../chess/eval";
import { turnOf } from "../chess/position";
import { addMove, mainline, movesTo, newGame, promoteVariation, rootFen, updateNode, type GameState } from "../chess/tree";
import { gameTitle } from "../components/ImportModal";
import { setClassNag } from "../engine/report";
import { engineSocket } from "../lib/api";
import { moveSound, playSound } from "../lib/sound";
import { engineSettingsFor, useSettings } from "../store/settings";
import { useTabs, type LiveState, type Report } from "../store/tabs";

/*
 * Live games: follow a game while it is played (a Lichess stream relayed by the
 * server, or a screen capture read frame by frame, see capture.ts), append its
 * moves to the tab's main line and evaluate every new position so each move is
 * classified as it arrives. Lives outside React, like engine/report.ts, so tabs
 * in the background keep following.
 */

export interface LiveMove {
  uci: string;
  clock?: number | null; // seconds left after the move
}

const key = (tabId: string) => `live:${tabId}`;
const listeners = new Map<string, () => void>(); // tabId -> unsubscribe from the socket
const lichess = new Set<string>(); // tabs following a Lichess stream
const dropped = new Set<string>(); // Lichess watches to restart once the socket is back
const captures = new Map<string, () => void>(); // tabId -> stop the screen capture

const tabOf = (id: string) => useTabs.getState().tabs.find((t) => t.id === id);

export function lastId(g: GameState): string {
  const line = mainline(g);
  return line[line.length - 1];
}

export function patchLive(tabId: string, patch: Partial<LiveState>) {
  useTabs.getState().updateTab(tabId, (t) => (t.live ? { live: { ...t.live, ...patch } } : {}));
}

/**
 * Append moves at the end of the main line (ahead of any variation the user
 * explored there). The cursor follows only if it was on the last move.
 * Returns false if a move could not be played.
 */
export function appendMoves(tabId: string, moves: LiveMove[], sound = true): boolean {
  const t = tabOf(tabId);
  if (!t || !moves.length) return true;
  let g = t.game;
  const follow = g.cursor === lastId(g);
  const added: string[] = [];
  let last: { capture: boolean; check: boolean } | null = null;
  for (const m of moves) {
    const r = addMove(g, m.uci, lastId(g));
    if (!r) break;
    g = promoteVariation(r.game, r.id);
    if (m.clock !== undefined && m.clock !== null) g = updateNode(g, r.id, { clock: m.clock });
    added.push(r.id);
    last = r;
  }
  g = { ...g, cursor: follow ? lastId(g) : t.game.cursor };
  useTabs.getState().updateTab(tabId, (tab) => ({ game: g, live: tab.live && { ...tab.live, clockAt: Date.now() } }));
  if (sound && last && follow && moves.length === 1) moveSound(last);
  evaluate(tabId, added);
  return added.length === moves.length;
}

/** Start the tab's game over from `fen` (a different game, or a capture that lost track). */
export function resetGame(tabId: string, fen: string, headers: Record<string, string> = {}, moves: LiveMove[] = []) {
  engineSocket.send({ type: "eval_cancel", id: key(tabId) });
  let game = newGame(fen, headers);
  for (const m of moves) {
    const r = addMove(game, m.uci, lastId(game), m.clock !== undefined && m.clock !== null ? { clock: m.clock } : {});
    if (!r) break;
    game = r.game;
  }
  game = { ...game, cursor: lastId(game) };
  useTabs.getState().updateTab(tabId, (t) => ({
    game, report: undefined, title: headers.White ? gameTitle(game) : t.title, live: t.live && { ...t.live, clockAt: Date.now() },
  }));
  evaluate(tabId, mainline(game));
}

function applySnapshot(tabId: string, msg: { headers: Record<string, string>; initialFen: string; moves: string[]; clocks: (number | null)[] }) {
  const t = tabOf(tabId);
  if (!t) return;
  const g = t.game;
  const known = movesTo(g, lastId(g));
  const sameStart = rootFen(g).split(" ").slice(0, 2).join(" ") === msg.initialFen.split(" ").slice(0, 2).join(" ");
  const continues = sameStart && known.length <= msg.moves.length && known.every((u, i) => u === msg.moves[i]);
  const moves = msg.moves.map((uci, i) => ({ uci, clock: msg.clocks[i] }));
  if (!continues) return resetGame(tabId, msg.initialFen, msg.headers, moves);
  const game = { ...g, headers: { ...g.headers, ...msg.headers } };
  useTabs.getState().updateTab(tabId, () => ({ game, title: gameTitle(game) }));
  appendMoves(tabId, moves.slice(known.length), false);
}

function endGame(tabId: string, result: string, reason: string) {
  const t = tabOf(tabId);
  if (!t) return;
  if (t.live?.status === "live") playSound("end");
  useTabs.getState().updateTab(tabId, (tab) => ({
    game: { ...tab.game, headers: { ...tab.game.headers, Result: result } },
    live: tab.live && { ...tab.live, status: "ended", reason },
  }));
}

// ------------------------------------------------------------ evaluation

/** Queue positions for the per-move evaluation (positions already scored are skipped). */
export function evaluate(tabId: string, ids: string[]) {
  const t = tabOf(tabId);
  if (!t) return;
  listen(tabId);
  const s = useSettings.getState();
  const engine = s.analysisEngines[0] ?? "stockfish";
  const es = engineSettingsFor(s.engineSettings, engine);
  for (const id of ids) {
    if (!t.game.nodes[id] || t.game.nodes[id].score) continue;
    engineSocket.send({
      type: "eval", id: key(tabId), tag: id, engine, fen: rootFen(t.game), moves: movesTo(t.game, id),
      limit: { type: "depth", value: s.liveDepth },
      // half the threads: the engine panel analyses the current move at the same time
      threads: Math.max(1, Math.floor(es.threads / 2)), hash: es.hash, options: es.options,
    });
  }
}

function classOf(g: GameState, parentId: string, id: string): MoveClass | null {
  const prev = g.nodes[parentId];
  const node = g.nodes[id];
  if (!prev.score || !node.score) return null;
  return classifyPlayed(prev.fen, node.uci!, { score: prev.score, best: prev.best, second: prev.second }, node.score);
}

/** Accuracy and move classes over the main line, as far as it has been evaluated. */
function liveReport(g: GameState): Report {
  const ids = mainline(g);
  let n = 0;
  while (n < ids.length && g.nodes[ids[n]].score) n++;
  const scored = ids.slice(0, n);
  const scores = scored.map((id) => g.nodes[id].score!);
  const classes: Record<string, MoveClass> = {};
  for (let i = 1; i < n; i++) classes[ids[i]] = classOf(g, ids[i - 1], ids[i])!;
  const startsWhite = turnOf(g.nodes[ids[0]].fen) === "white";
  return {
    status: "live", progress: n, total: ids.length, nodeIds: scored, classes,
    accuracy: n > 1 ? gameAccuracy(scores, startsWhite) : undefined,
    cpl: n > 1 ? averageCpl(scores, startsWhite) : undefined,
  };
}

function onEval(tabId: string, msg: { tag: string; score: any; best?: string; second?: any }) {
  const t = tabOf(tabId);
  if (!t?.game.nodes[msg.tag]) return;
  let g = updateNode(t.game, msg.tag, { score: msg.score, best: msg.best, second: msg.second });
  const ids = mainline(g);
  const i = ids.indexOf(msg.tag);
  // this move, and the next one, which is judged against this position
  for (const j of [i, i + 1]) {
    if (i < 0 || j < 1 || j >= ids.length) continue;
    const cls = classOf(g, ids[j - 1], ids[j]);
    if (cls) g = setClassNag(g, ids[j], cls);
  }
  useTabs.getState().updateTab(tabId, () => ({ game: g, report: liveReport(g) }));
}

// ------------------------------------------------------------ messages

function listen(tabId: string) {
  if (listeners.has(tabId)) return;
  listeners.set(tabId, engineSocket.subscribe(key(tabId), (msg) => {
    if (!tabOf(tabId)) return;
    switch (msg.type) {
      case "live_game":
        applySnapshot(tabId, msg);
        break;
      case "live_move":
        // cannot happen unless client and server disagree: ask for a fresh snapshot
        if (!appendMoves(tabId, [{ uci: msg.uci, clock: msg.clock }])) sendStart(tabId);
        break;
      case "live_status":
        patchLive(tabId, { status: msg.state, error: undefined });
        break;
      case "live_end":
        endGame(tabId, msg.result, msg.reason);
        break;
      case "live_error":
        lichess.delete(tabId);
        patchLive(tabId, { status: "error", error: msg.message });
        break;
      case "eval_result":
        onEval(tabId, msg);
        break;
      case "disconnected":
        if (lichess.has(tabId)) {
          dropped.add(tabId);
          patchLive(tabId, { status: "reconnecting" });
        }
        break;
    }
  }));
}

function sendStart(tabId: string) {
  const live = tabOf(tabId)?.live;
  if (!live) return;
  engineSocket.send({
    type: "live_start", id: key(tabId), url: live.url, round: live.round, game: live.game,
    token: useSettings.getState().lichessToken || undefined,
  });
}

// the server forgets watches and queued evaluations when the socket drops
engineSocket.onStatus((up) => {
  if (!up) return;
  for (const tabId of dropped) {
    sendStart(tabId);
    const t = tabOf(tabId);
    if (t) evaluate(tabId, mainline(t.game));
  }
  dropped.clear();
});

// closing a tab stops whatever it was following
useTabs.subscribe((s) => {
  for (const tabId of [...listeners.keys()]) {
    if (s.tabs.some((t) => t.id === tabId)) continue;
    stopWatch(tabId);
    engineSocket.send({ type: "eval_cancel", id: key(tabId) });
    listeners.get(tabId)?.();
    listeners.delete(tabId);
  }
});

// ------------------------------------------------------------ public

export function startLichessWatch(tabId: string) {
  const t = tabOf(tabId);
  if (!t?.live) return;
  listen(tabId);
  lichess.add(tabId);
  patchLive(tabId, { status: "connecting", error: undefined, reason: undefined });
  sendStart(tabId);
  evaluate(tabId, mainline(t.game)); // anything left unevaluated, e.g. after a reload
}

/** Called by capture.ts: `stop` ends that tab's screen capture. */
export function registerCapture(tabId: string, stop: () => void) {
  captures.set(tabId, stop);
  const t = tabOf(tabId);
  if (t) evaluate(tabId, mainline(t.game)); // the starting position, so the first move can be judged
}

export function unregisterCapture(tabId: string) {
  captures.delete(tabId);
}

export function stopWatch(tabId: string) {
  dropped.delete(tabId);
  if (lichess.delete(tabId)) engineSocket.send({ type: "live_stop", id: key(tabId) });
  const stop = captures.get(tabId);
  captures.delete(tabId);
  stop?.();
  const live = tabOf(tabId)?.live;
  if (live && live.status !== "ended" && live.status !== "error") patchLive(tabId, { status: "stopped" });
}

export const isWatching = (tabId: string) => lichess.has(tabId) || captures.has(tabId);
