import { startTransition, useEffect, useRef, useState } from "react";
import { engineSocket } from "../lib/api";
import { engineSettingsFor, useSettings } from "../store/settings";
import type { Score } from "../chess/eval";

export interface EngineLine {
  multipv: number;
  depth: number;
  score: Score;
  pv: string[];
  san: string[];
}

export interface AnalysisResult {
  engine: string;
  fen: string;
  depth?: number;
  seldepth?: number;
  nodes?: number;
  nps?: number;
  time?: number;
  hashfull?: number;
  lines: EngineLine[];
  done: boolean;
  gameOver?: string;
  error?: string;
}

export interface AnalysisPosition {
  rootFen: string;
  moves: string[];
  fen: string; // position after `moves`, used to discard stale results
}

/**
 * Live analysis of the current position by each engine in `engineIds`.
 * Results that belong to a position other than `pos.fen` are dropped.
 */
export function useAnalysis(tabId: string, engineIds: string[], pos: AnalysisPosition, active: boolean) {
  const [results, setResults] = useState<Record<string, AnalysisResult>>({});
  const tokens = useRef<Record<string, number>>({});
  const requested = useRef<Record<string, string>>({});
  const allSettings = useSettings((s) => s.engineSettings);
  const enginesKey = engineIds.join("|");

  useEffect(() => {
    const unsubs = engineIds.map((eid) =>
      engineSocket.subscribe(`${tabId}:${eid}`, (msg) => {
        if (msg.type === "disconnected") {
          setResults((r) => ({ ...r, [eid]: { engine: eid, fen: requested.current[eid], lines: [], done: true, error: "Lost connection to the server" } }));
          return;
        }
        if (msg.token !== tokens.current[eid]) return;
        // not urgent: rendering this gives way to anything else, above all a new position on the board
        if (msg.type === "analysis") startTransition(() => setResults((r) => ({ ...r, [eid]: { ...msg, fen: requested.current[eid] } })));
        else if (msg.type === "error")
          setResults((r) => ({ ...r, [eid]: { engine: eid, fen: requested.current[eid], lines: [], done: true, error: msg.message } }));
      }),
    );
    return () => {
      unsubs.forEach((u) => u());
      engineIds.forEach((eid) => engineSocket.send({ type: "close", id: `${tabId}:${eid}` }));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId, enginesKey]);

  const movesKey = pos.moves.join(" ");
  const settingsKey = JSON.stringify(engineIds.map((e) => engineSettingsFor(allSettings, e)));
  useEffect(() => {
    for (const eid of engineIds) {
      const id = `${tabId}:${eid}`;
      if (!active) {
        engineSocket.send({ type: "stop", id });
        continue;
      }
      const token = (tokens.current[eid] ?? 0) + 1;
      tokens.current[eid] = token;
      requested.current[eid] = pos.fen;
      const s = engineSettingsFor(allSettings, eid);
      engineSocket.send({
        type: "analyze", id, token, engine: eid, fen: pos.rootFen, moves: pos.moves,
        multipv: s.multipv, threads: s.threads, hash: s.hash, options: s.options, limit: s.limit,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId, enginesKey, active, pos.rootFen, movesKey, settingsKey]);

  const current: Record<string, AnalysisResult> = {};
  for (const eid of engineIds) if (results[eid]?.fen === pos.fen) current[eid] = results[eid];
  return current;
}
