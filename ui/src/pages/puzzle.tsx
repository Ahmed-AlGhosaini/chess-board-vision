import { useEffect } from "react";
import { Alert, Badge, Button, Group, Loader, Paper, Select, Stack, Text } from "@mantine/core";
import { IconBulb, IconCheck, IconEye, IconPlayerSkipForward, IconRefresh, IconX } from "@tabler/icons-react";
import type { DrawShape } from "chessground/draw";
import type { Key } from "chessground/types";
import { parsePgnText } from "../chess/pgn";
import { gameOutcome, moveFromUci, posFromFen, turnOf, uciSquares } from "../chess/position";
import { addLine, addMove, deleteNode, mainline, newGame, type GameState } from "../chess/tree";
import { api } from "../lib/api";
import { moveSound, playSound } from "../lib/sound";
import { useTabs, type PuzzleState, type Tab } from "../store/tabs";
import { create } from "zustand";
import { persist } from "zustand/middleware";

export const usePuzzlePrefs = create<{ angle: string; difficulty: string; set: (p: Partial<{ angle: string; difficulty: string }>) => void }>()(
  persist((set) => ({ angle: "", difficulty: "normal", set: (p) => set(p) }), { name: "chessvision-puzzles" }),
);

const THEMES = [
  ["", "Any theme"], ["mateIn1", "Mate in 1"], ["mateIn2", "Mate in 2"], ["mateIn3", "Mate in 3"], ["fork", "Fork"], ["pin", "Pin"],
  ["skewer", "Skewer"], ["discoveredAttack", "Discovered attack"], ["sacrifice", "Sacrifice"], ["hangingPiece", "Hanging piece"],
  ["endgame", "Endgame"], ["middlegame", "Middlegame"], ["opening", "Opening"], ["short", "Short"], ["long", "Long"],
].map(([value, label]) => ({ value, label }));

export async function loadPuzzle(tabId: string) {
  const { updateTab } = useTabs.getState();
  const prev = useTabs.getState().tabs.find((t) => t.id === tabId)?.puzzle;
  const keep = { streak: prev?.streak ?? 0, history: prev?.history ?? [] };
  updateTab(tabId, (t) => ({ puzzle: { ...(t.puzzle ?? emptyPuzzle()), ...keep, status: "loading", error: undefined } }));
  try {
    const { angle, difficulty } = usePuzzlePrefs.getState();
    const q = new URLSearchParams({ ...(angle ? { angle } : {}), ...(difficulty ? { difficulty } : {}) });
    const data = await api(`/api/lichess/puzzle?${q}`);
    const parsed = parsePgnText(data.game.pgn)[0];
    if (!parsed) throw new Error("Could not read the puzzle's game");
    const line = mainline(parsed);
    // the puzzle starts after `initialPly + 1` plies; fall back to the end of the game text
    const candidates = [data.puzzle.initialPly + 1, line.length - 1].filter((i) => i >= 0 && i < line.length);
    const startIdx = candidates.find((i) => moveFromUci(posFromFen(parsed.nodes[line[i]].fen), data.puzzle.solution[0])) ?? line.length - 1;
    let game: GameState = newGame(undefined, { Event: `Lichess puzzle ${data.puzzle.id}`, Site: `https://lichess.org/training/${data.puzzle.id}` });
    game = addLine(game, line.slice(1, startIdx + 1).map((id) => parsed.nodes[id].uci!), game.root);
    const startNode = game.cursor;
    updateTab(tabId, () => ({
      title: `Puzzle ${data.puzzle.rating}`,
      game,
      orientation: turnOf(game.nodes[startNode].fen),
      analysisOn: false,
      report: undefined,
      puzzle: {
        ...keep, id: data.puzzle.id, rating: data.puzzle.rating, themes: data.puzzle.themes ?? [],
        solution: data.puzzle.solution, startNode, step: 0, status: "solving", hint: 0,
      },
    }));
  } catch (e: any) {
    updateTab(tabId, (t) => ({
      puzzle: { ...(t.puzzle ?? emptyPuzzle()), status: "error", error: e.status === 401 ? "Lichess asked for authentication: add an API token in Settings." : e.message },
    }));
  }
}

const emptyPuzzle = (): PuzzleState => ({ id: "", rating: 0, themes: [], solution: [], startNode: "root", step: 0, status: "loading", hint: 0, streak: 0, history: [] });

/** Handle a move made on the board while solving. */
export function puzzleMove(tab: Tab, uci: string) {
  const { updateTab } = useTabs.getState();
  const p = tab.puzzle!;
  const g = tab.game;
  if (p.status !== "solving") {
    // after the puzzle the board is a normal analysis board
    const r = addMove(g, uci);
    if (r) {
      moveSound(r);
      updateTab(tab.id, () => ({ game: r.game }));
    }
    return;
  }
  const expected = p.solution[p.step];
  const r = addMove(g, uci);
  if (!r) return;
  // any mating move counts as correct on the last move
  const correct = r.game.nodes[r.id].uci === expected || (gameOutcome(r.game.nodes[r.id].fen)?.reason === "Checkmate");
  if (!correct) {
    playSound("error");
    updateTab(tab.id, () => ({
      game: r.game,
      puzzle: { ...p, status: "failed", streak: 0, history: [{ id: p.id, rating: p.rating, solved: false }, ...p.history].slice(0, 50) },
    }));
    return;
  }
  moveSound(r);
  const step = p.step + 1;
  if (step >= p.solution.length || gameOutcome(r.game.nodes[r.id].fen)) {
    playSound("success");
    updateTab(tab.id, () => ({
      game: r.game,
      puzzle: { ...p, step, status: "solved", hint: 0, streak: p.streak + 1, history: [{ id: p.id, rating: p.rating, solved: true }, ...p.history].slice(0, 50) },
    }));
    return;
  }
  updateTab(tab.id, () => ({ game: r.game, puzzle: { ...p, step, hint: 0 } }));
  // the opponent's reply
  setTimeout(() => {
    const cur = useTabs.getState().tabs.find((t) => t.id === tab.id);
    if (!cur?.puzzle || cur.puzzle.status !== "solving" || cur.game.cursor !== r.id) return;
    const reply = addMove(cur.game, p.solution[step], r.id);
    if (!reply) return;
    moveSound(reply);
    updateTab(tab.id, () => ({ game: reply.game, puzzle: { ...cur.puzzle!, step: step + 1 } }));
  }, 450);
}

export function puzzleShapes(tab: Tab): DrawShape[] {
  const p = tab.puzzle;
  if (!p || p.status !== "solving" || !p.hint || !p.solution[p.step]) return [];
  const [from, to] = uciSquares(p.solution[p.step]);
  return p.hint === 1 ? [{ orig: from as Key, brush: "hint" }] : [{ orig: from as Key, dest: to as Key, brush: "hint" }];
}

export function PuzzlePanel({ tab }: { tab: Tab }) {
  const p = tab.puzzle;
  const updateTab = useTabs((s) => s.updateTab);
  const prefs = usePuzzlePrefs();

  useEffect(() => {
    if (!p || (p.status === "loading" && !p.id)) void loadPuzzle(tab.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id]);

  if (!p) return null;
  const toMove = p.startNode && tab.game.nodes[p.startNode] ? turnOf(tab.game.nodes[p.startNode].fen) : "white";

  const retry = () => {
    let game = tab.game;
    const line = mainline(game, p.startNode);
    // drop everything after the last correct solution move
    const keep = line[p.step] ?? p.startNode;
    for (const c of [...game.nodes[keep].children]) game = deleteNode(game, c);
    updateTab(tab.id, () => ({ game: { ...game, cursor: keep }, puzzle: { ...p, status: "solving" } }));
  };

  const showSolution = () => {
    const game = addLine({ ...tab.game, cursor: p.startNode }, p.solution, p.startNode);
    updateTab(tab.id, () => ({
      game,
      puzzle: { ...p, status: p.status === "solved" ? "solved" : "failed", streak: p.status === "solving" ? 0 : p.streak,
        history: p.status === "solving" ? [{ id: p.id, rating: p.rating, solved: false }, ...p.history].slice(0, 50) : p.history },
    }));
  };

  return (
    <Paper withBorder p="sm" radius="md">
      <Stack gap="xs">
        <Group justify="space-between">
          <Group gap="xs">
            <Text fw={600}>Puzzle</Text>
            {p.rating > 0 && <Badge variant="light">{p.rating}</Badge>}
            {p.streak > 0 && <Badge color="orange" variant="light">streak {p.streak}</Badge>}
          </Group>
          <Group gap={4}>
            <Select size="xs" w={150} data={THEMES} value={prefs.angle} onChange={(v) => prefs.set({ angle: v ?? "" })} allowDeselect={false} />
            <Select size="xs" w={110} value={prefs.difficulty} onChange={(v) => prefs.set({ difficulty: v ?? "normal" })} allowDeselect={false}
              data={["easiest", "easier", "normal", "harder", "hardest"].map((d) => ({ value: d, label: d[0].toUpperCase() + d.slice(1) }))} />
          </Group>
        </Group>
        {p.status === "loading" && <Group gap="xs"><Loader size="xs" /><Text size="sm">Fetching a puzzle from Lichess…</Text></Group>}
        {p.status === "error" && <Alert color="red" p="xs">{p.error}</Alert>}
        {p.status === "solving" && <Text size="sm">Find the best move for <b>{toMove}</b>.</Text>}
        {p.status === "solved" && <Alert color="green" p="xs" icon={<IconCheck size={16} />}>Solved! The engine is available to explore the position.</Alert>}
        {p.status === "failed" && <Alert color="red" p="xs" icon={<IconX size={16} />}>That's not the move. Try again or look at the solution.</Alert>}
        <Group gap="xs">
          {p.status === "solving" && (
            <Button size="xs" variant="default" leftSection={<IconBulb size={14} />} onClick={() => updateTab(tab.id, () => ({ puzzle: { ...p, hint: Math.min(2, p.hint + 1) } }))}>
              {p.hint ? "More help" : "Hint"}
            </Button>
          )}
          {p.status === "failed" && <Button size="xs" variant="default" leftSection={<IconRefresh size={14} />} onClick={retry}>Retry</Button>}
          {(p.status === "solving" || p.status === "failed") && (
            <Button size="xs" variant="default" leftSection={<IconEye size={14} />} onClick={showSolution}>Solution</Button>
          )}
          <Button size="xs" leftSection={<IconPlayerSkipForward size={14} />} onClick={() => loadPuzzle(tab.id)} loading={p.status === "loading"}>
            {p.status === "solving" ? "Skip" : "Next puzzle"}
          </Button>
        </Group>
        {p.status !== "solving" && p.themes.length > 0 && (
          <Group gap={4}>{p.themes.map((t) => <Badge key={t} size="xs" variant="outline">{t}</Badge>)}</Group>
        )}
        {p.history.length > 0 && (
          <Group gap={4}>
            {p.history.slice(0, 20).map((h, i) => (
              <Badge key={i} size="sm" color={h.solved ? "green" : "red"} variant="light" component="a" href={`https://lichess.org/training/${h.id}`} target="_blank" style={{ cursor: "pointer" }}>
                {h.rating}
              </Badge>
            ))}
          </Group>
        )}
      </Stack>
    </Paper>
  );
}
