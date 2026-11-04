import { classifyPlayed } from "../chess/classify";
import { averageCpl, gameAccuracy, NAG_FOR_CLASS, type MoveClass, type Score } from "../chess/eval";
import { turnOf } from "../chess/position";
import { addLine, mainline, rootFen, updateNode, type GameState } from "../chess/tree";
import { engineSocket } from "../lib/api";
import { engineSettingsFor, useSettings } from "../store/settings";
import { useTabs } from "../store/tabs";

const running = new Map<string, () => void>();
const QUALITY_NAGS = [1, 2, 3, 4, 5, 6];

/**
 * Evaluate every main-line position of a tab's game on the server, then
 * classify each move, compute accuracy, annotate the moves and (optionally)
 * add the engine's better line after mistakes and blunders.
 */
export function startReport(tabId: string) {
  cancelReport(tabId);
  const { tabs, updateTab, updateGame } = useTabs.getState();
  const tab = tabs.find((t) => t.id === tabId);
  if (!tab) return;
  const settings = useSettings.getState();
  const engine = settings.analysisEngines[0] ?? "stockfish";
  const es = engineSettingsFor(settings.engineSettings, engine);
  const g = tab.game;
  const ids = mainline(g);
  const moves = ids.slice(1).map((id) => g.nodes[id].uci!);
  const scores: Score[] = [];
  const bests: (string | undefined)[] = [];
  const seconds: (Score | undefined)[] = [];
  const pvs: string[][] = [];
  const key = `report:${tabId}`;
  const classOf = (i: number) => classifyPlayed(g.nodes[ids[i - 1]].fen, g.nodes[ids[i]].uci!,
    { score: scores[i - 1], best: bests[i - 1], second: seconds[i - 1] }, scores[i]);
  updateTab(tabId, () => ({ report: { status: "running", progress: 0, total: ids.length, nodeIds: ids } }));

  const unsub = engineSocket.subscribe(key, (msg) => {
    if (msg.type === "report_progress") {
      scores[msg.index] = msg.score;
      bests[msg.index] = msg.best;
      seconds[msg.index] = msg.second;
      pvs[msg.index] = msg.pv ?? [];
      const nid = ids[msg.index];
      updateGame(tabId, (game) => (game.nodes[nid] ? updateNode(game, nid, { score: msg.score, best: msg.best, second: msg.second }) : game));
      updateTab(tabId, (t) => ({ report: t.report && { ...t.report, progress: msg.index + 1 } }));
    } else if (msg.type === "report_done") {
      finish();
      updateGame(tabId, (game) => annotate(game, ids, classOf, pvs, settings.reportVariations));
    } else if (msg.type === "report_error" || msg.type === "disconnected") {
      finish();
      updateTab(tabId, (t) => ({ report: t.report && { ...t.report, status: "error", error: msg.message ?? "Lost connection to the server" } }));
    }
  });

  function finish() {
    unsub();
    running.delete(tabId);
    if (scores.length < ids.length) return;
    const startsWhite = turnOf(g.nodes[ids[0]].fen) === "white";
    const classes: Record<string, MoveClass> = {};
    for (let i = 1; i < ids.length; i++) classes[ids[i]] = classOf(i);
    updateTab(tabId, () => ({
      report: {
        status: "done", progress: ids.length, total: ids.length, nodeIds: ids, classes,
        accuracy: gameAccuracy(scores, startsWhite), cpl: averageCpl(scores, startsWhite),
      },
    }));
  }

  running.set(tabId, unsub);
  engineSocket.send({
    type: "report", id: key, engine, fen: rootFen(g), moves,
    limit: { type: "depth", value: settings.reportDepth }, threads: es.threads, hash: es.hash, options: es.options,
  });
}

function annotate(g: GameState, ids: string[], classOf: (i: number) => MoveClass, pvs: string[][], addVariations: boolean): GameState {
  let game = g;
  const cursor = g.cursor;
  for (let i = 1; i < ids.length; i++) {
    if (!game.nodes[ids[i]]) continue;
    const cls = classOf(i);
    game = setClassNag(game, ids[i], cls);
    if (addVariations && (cls === "mistake" || cls === "blunder") && pvs[i - 1]?.length) {
      game = addLine(game, pvs[i - 1].slice(0, 6), ids[i - 1]);
    }
  }
  return { ...game, cursor: game.nodes[cursor] ? cursor : game.root };
}

/** Replace a move's quality NAG (!, ?, ?? ...) with the one for its class. */
export function setClassNag(g: GameState, id: string, cls: MoveClass): GameState {
  const nag = NAG_FOR_CLASS[cls];
  const nags = (g.nodes[id].nags ?? []).filter((x) => !QUALITY_NAGS.includes(x));
  return updateNode(g, id, { nags: nag ? [...nags, nag] : nags });
}

export function cancelReport(tabId: string) {
  const unsub = running.get(tabId);
  if (!unsub) return;
  unsub();
  running.delete(tabId);
  engineSocket.send({ type: "report_cancel", id: `report:${tabId}` });
  useTabs.getState().updateTab(tabId, () => ({ report: undefined }));
}
