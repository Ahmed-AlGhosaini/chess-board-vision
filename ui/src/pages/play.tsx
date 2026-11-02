import { useEffect, useRef, useState } from "react";
import { Alert, Button, Group, Paper, Stack, Text } from "@mantine/core";
import { IconArrowBackUp, IconFlag, IconPlayerPlay, IconSearch } from "@tabler/icons-react";
import { gameOutcome, turnOf, type Color } from "../chess/position";
import { addMove, deleteNode, isThreefold, mainline, rootFen, movesTo, type GameState } from "../chess/tree";
import { api } from "../lib/api";
import { moveSound, playSound } from "../lib/sound";
import { useTabs, type Tab } from "../store/tabs";
import { useUi } from "../store/ui";

const lastId = (g: GameState) => {
  const line = mainline(g);
  return line[line.length - 1];
};

/** End-of-game check for the position after the last move. */
function outcomeOf(g: GameState): { result: string; reason: string } | null {
  const id = lastId(g);
  const o = gameOutcome(g.nodes[id].fen);
  if (o) return o;
  if (isThreefold(g, id)) return { result: "1/2-1/2", reason: "Threefold repetition" };
  return null;
}

/**
 * Play-mode controller: clocks, engine replies, game end. Clocks only run
 * while the tab is open; the remaining times are saved after every move.
 */
export function usePlay(tab: Tab) {
  const { updateTab } = useTabs.getState();
  const play = tab.play!;
  const g = tab.game;
  const end = lastId(g);
  const turn = turnOf(g.nodes[end].fen);
  const turnStart = useRef(performance.now());
  const [now, setNow] = useState(performance.now());
  const thinking = useRef<string | null>(null);

  // restart the turn timer whenever a move is added
  useEffect(() => {
    turnStart.current = performance.now();
  }, [end]);

  const elapsed = play.status === "playing" && play.clock && g.nodes[end].ply > g.nodes[g.root].ply ? now - turnStart.current : 0;
  const times: Record<Color, number> = { ...play.times, [turn]: play.times[turn] - elapsed };

  const finish = (result: string, reason: string) => {
    playSound("end");
    updateTab(tab.id, (t) => ({
      play: { ...t.play!, status: "over", result, reason, times: { ...t.play!.times, [turn]: Math.max(0, times[turn]) } },
      game: { ...t.game, headers: { ...t.game.headers, Result: result } },
    }));
  };

  // clock tick + flag fall
  useEffect(() => {
    if (play.status !== "playing" || !play.clock) return;
    const id = setInterval(() => setNow(performance.now()), 100);
    return () => clearInterval(id);
  }, [play.status, play.clock]);
  useEffect(() => {
    if (play.status === "playing" && play.clock && times[turn] <= 0)
      finish(turn === "white" ? "0-1" : "1-0", `${turn === "white" ? "White" : "Black"} ran out of time`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [now]);

  /** Append a move at the end of the game and charge the mover's clock. */
  const commit = (uci: string): boolean => {
    const t = useTabs.getState().tabs.find((x) => x.id === tab.id);
    if (!t?.play || t.play.status !== "playing") return false;
    const at = lastId(t.game);
    const mover = turnOf(t.game.nodes[at].fen);
    const r = addMove(t.game, uci, at);
    if (!r) return false;
    moveSound(r);
    const spent = t.play.clock && t.game.nodes[at].ply > t.game.nodes[t.game.root].ply ? performance.now() - turnStart.current : 0;
    const left = t.play.clock ? t.play.times[mover] - spent + t.play.clock.increment : 0;
    const game = { ...r.game, nodes: { ...r.game.nodes, [r.id]: { ...r.game.nodes[r.id], clock: t.play.clock ? Math.max(0, left / 1000) : undefined } } };
    const outcome = outcomeOf(game);
    updateTab(tab.id, () => ({
      game: outcome ? { ...game, headers: { ...game.headers, Result: outcome.result } } : game,
      play: { ...t.play!, times: { ...t.play!.times, [mover]: left }, ...(outcome ? { status: "over" as const, result: outcome.result, reason: outcome.reason } : {}) },
    }));
    if (outcome) playSound("end");
    return true;
  };

  // engine reply
  useEffect(() => {
    if (play.status !== "playing" || play.engineColor !== turn || thinking.current === end) return;
    thinking.current = end;
    const t0 = performance.now();
    const clock = play.clock ? { wtime: Math.max(100, times.white), btime: Math.max(100, times.black), winc: play.clock.increment, binc: play.clock.increment } : undefined;
    api<{ uci: string | null }>("/api/engine/bestmove", {
      method: "POST",
      json: { engine: play.engine, level: play.level, fen: rootFen(g), moves: movesTo(g, end), clock },
    })
      .then(async (r) => {
        // short pause so instant replies are still visible
        const wait = 350 - (performance.now() - t0);
        if (wait > 0) await new Promise((res) => setTimeout(res, wait));
        const cur = useTabs.getState().tabs.find((x) => x.id === tab.id);
        if (r.uci && cur && lastId(cur.game) === end) commit(r.uci);
      })
      .catch(() => {
        thinking.current = null;
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [end, play.status, play.engineColor]);

  const humanToMove = play.status === "playing" && play.engineColor !== turn;

  const takeback = () => {
    const t = useTabs.getState().tabs.find((x) => x.id === tab.id)!;
    let game = t.game;
    const steps = play.engineColor && play.engineColor !== turn ? 2 : 1;
    for (let i = 0; i < steps; i++) {
      const id = lastId(game);
      if (id === game.root) break;
      game = deleteNode(game, id);
    }
    thinking.current = null;
    updateTab(tab.id, () => ({ game: { ...game, cursor: lastId(game) } }));
  };

  const resign = () => {
    const loser: Color = play.engineColor ? (play.engineColor === "white" ? "black" : "white") : turn;
    finish(loser === "white" ? "0-1" : "1-0", `${loser === "white" ? "White" : "Black"} resigned`);
  };

  return { times, turn, humanToMove, commit, takeback, resign, atEnd: g.cursor === end, end };
}

export function PlayPanel({ tab, controls }: { tab: Tab; controls: ReturnType<typeof usePlay> }) {
  const play = tab.play!;
  const updateTab = useTabs((s) => s.updateTab);
  const openPlay = useUi((s) => s.openPlay);
  const over = play.status === "over";
  return (
    <Paper withBorder p="sm" radius="md">
      <Stack gap="xs">
        {over ? (
          <Alert color="blue" p="xs" title={play.result === "1/2-1/2" ? "Draw" : play.result === "1-0" ? "White wins" : "Black wins"}>
            {play.reason}
          </Alert>
        ) : (
          <Text size="sm">
            {play.engineColor
              ? controls.humanToMove ? "Your move" : "Engine is thinking…"
              : `${controls.turn === "white" ? "White" : "Black"} to move`}
            {!controls.atEnd && " (viewing an earlier position: go to the last move to play)"}
          </Text>
        )}
        <Group gap="xs">
          {!over && (
            <>
              <Button size="xs" variant="default" leftSection={<IconArrowBackUp size={14} />} onClick={controls.takeback}
                disabled={Object.keys(tab.game.nodes).length < 2}>Takeback</Button>
              <Button size="xs" variant="default" color="red" leftSection={<IconFlag size={14} />} onClick={controls.resign}>Resign</Button>
            </>
          )}
          {over && (
            <>
              <Button size="xs" leftSection={<IconSearch size={14} />}
                onClick={() => updateTab(tab.id, (t) => ({ type: "analysis", title: t.title.replace(/^vs /, "Game vs "), analysisOn: true }))}>
                Analyse game
              </Button>
              <Button size="xs" variant="default" leftSection={<IconPlayerPlay size={14} />} onClick={() => openPlay(tab.game.nodes[tab.game.root].fen, tab.orientation)}>
                New game
              </Button>
            </>
          )}
        </Group>
      </Stack>
    </Paper>
  );
}
