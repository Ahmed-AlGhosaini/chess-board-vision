import { useEffect, useReducer, useRef } from "react";
import { classifyPlayed, type PositionEval } from "../chess/classify";
import type { MoveClass } from "../chess/eval";
import { current, isOnMainline, movesTo, rootFen } from "../chess/tree";
import { engineSocket } from "../lib/api";
import { engineSettingsFor, useSettings } from "../store/settings";
import type { Tab } from "../store/tabs";

// null: the engine could not evaluate this position, do not ask again
const cache = new Map<string, PositionEval | null>();
const CACHE_LIMIT = 5000;

/**
 * Class of the move shown on the board. Scores stored by a game report or a
 * live game are used as they are; otherwise, while `active`, the positions
 * before and after the move are evaluated in the background at a fixed depth,
 * so the verdict stays stable while the engine panel's search keeps deepening.
 */
export function useMoveClass(tab: Tab, engine: string | undefined, active: boolean): MoveClass | null {
  const [tick, refresh] = useReducer((x: number) => x + 1, 0);
  const busy = useRef(false);
  const depth = useSettings((s) => s.liveDepth);
  const g = tab.game;
  const node = current(g);
  const parent = node.parent ? g.nodes[node.parent] : null;
  // a live game's main line is evaluated by live/watch.ts
  const enabled = active && !!engine && !!parent && !(tab.type === "live" && isOnMainline(g, node.id));
  const id = `moveclass:${tab.id}`;
  const keyOf = (fen: string) => `${engine}|${depth}|${fen}`;

  useEffect(() => {
    if (!enabled) return;
    const unsub = engineSocket.subscribe(id, (msg) => {
      if (msg.type === "eval_result" || msg.type === "eval_error") {
        if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
        cache.set(msg.tag, msg.type === "eval_result" ? { score: msg.score, best: msg.best, second: msg.second } : null);
        busy.current = false;
        refresh();
      } else if (msg.type === "disconnected") busy.current = false;
    });
    const unstatus = engineSocket.onStatus((up) => up && refresh());
    return () => {
      unsub();
      unstatus();
      busy.current = false;
      engineSocket.send({ type: "eval_cancel", id }); // also stops the search and frees the engine
    };
  }, [id, enabled]);

  // one search at a time, always for what is on the board now: stepping quickly
  // through a game leaves at most one stale search running
  const storedBefore = parent?.score && parent.best;
  const wanted = !enabled ? [] : [...(storedBefore ? [] : [parent!]), ...(node.score ? [] : [node])];
  const next = wanted.find((n) => !cache.has(keyOf(n.fen)));
  const nextKey = next && keyOf(next.fen);
  useEffect(() => {
    if (!next || !nextKey || busy.current) return;
    busy.current = true;
    const es = engineSettingsFor(useSettings.getState().engineSettings, engine!);
    engineSocket.send({
      type: "eval", id, tag: nextKey, engine, fen: rootFen(g), moves: movesTo(g, next.id),
      limit: { type: "depth", value: depth },
      // half the threads: the engine panel analyses this move at the same time
      threads: Math.max(1, Math.floor(es.threads / 2)), hash: es.hash, options: es.options,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nextKey, enabled, tick]);

  if (!parent || !node.uci) return null;
  const fresh = (fen: string) => (enabled ? cache.get(keyOf(fen)) ?? undefined : undefined);
  const before: PositionEval | undefined = storedBefore
    ? { score: parent.score!, best: parent.best, second: parent.second }
    : fresh(parent.fen);
  const after = node.score ?? fresh(node.fen)?.score;
  return before && after ? classifyPlayed(parent.fen, node.uci, before, after) : null;
}
