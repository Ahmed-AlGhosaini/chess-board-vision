import { useState } from "react";
import { Alert, Button, Divider, FileButton, Group, Modal, Stack, Text, Textarea } from "@mantine/core";
import { IconFileUpload } from "@tabler/icons-react";
import { completeFen, looksLikeFen, parsePgnText } from "../chess/pgn";
import { fenError, type Color } from "../chess/position";
import { mainline, newGame, type GameState } from "../chess/tree";
import { api } from "../lib/api";
import { useTabs } from "../store/tabs";
import { useUi } from "../store/ui";

export function gameTitle(g: GameState): string {
  const w = g.headers.White && g.headers.White !== "?" ? g.headers.White : "";
  const b = g.headers.Black && g.headers.Black !== "?" ? g.headers.Black : "";
  return w || b ? `${w || "?"} – ${b || "?"}` : "Analysis";
}

function openPosition(fen: string, orientation?: Color): { opened: number; error?: string } {
  const err = fenError(fen);
  if (err) return { opened: 0, error: `FEN: ${err}` };
  useTabs.getState().openTab({ type: "analysis", title: "Position", game: newGame(fen), orientation: orientation ?? (fen.split(" ")[1] === "b" ? "black" : "white") });
  return { opened: 1 };
}

/** Open PGN games (or a FEN) as analysis tabs. Returns the number of tabs opened, or an error. */
export function importText(text: string, max = 20): { opened: number; error?: string } {
  const { openTab } = useTabs.getState();
  const t = text.trim();
  if (!t) return { opened: 0, error: "Nothing to import" };
  if (looksLikeFen(t)) return openPosition(completeFen(t));
  const games = parsePgnText(t);
  if (!games.length) return { opened: 0, error: "No readable game found. Paste a PGN, a FEN or a Lichess link." };
  for (const g of games.slice(0, max)) openTab({ type: "analysis", title: gameTitle(g), game: g });
  return { opened: Math.min(games.length, max), error: games.length > max ? `Opened the first ${max} of ${games.length} games. Import large files into a database instead.` : undefined };
}

// ------------------------------------------------------------ Lichess links

export const looksLikeLink = (text: string) => /^(https?:\/\/)?([\w-]+\.)*(lichess\.org|chess\.com)\/\S*$/i.test(text.trim());

/** What /api/lichess/load answers: a game (study, puzzle) or just a position. */
interface Loaded {
  pgn?: string;
  fen?: string;
  orientation?: Color | null;
  ply?: number | null;
}

const loadLink = (url: string) => api<Loaded>(`/api/lichess/load?url=${encodeURIComponent(url.trim())}`);

/** Open a Lichess game, study, analysis board or puzzle link, at the move it points to. */
export async function importLink(url: string, max = 20): Promise<{ opened: number; error?: string }> {
  let r: Loaded;
  try {
    r = await loadLink(url);
  } catch (e: any) {
    return { opened: 0, error: e.message || String(e) };
  }
  if (r.fen) return openPosition(r.fen, r.orientation ?? undefined);
  const games = parsePgnText(r.pgn ?? "");
  if (!games.length) return { opened: 0, error: "The game could not be read" };
  const { openTab } = useTabs.getState();
  games.slice(0, max).forEach((g, i) => {
    const line = mainline(g);
    const at = i === 0 && r.ply != null ? (line.find((id) => g.nodes[id].ply === r.ply) ?? line[line.length - 1]) : g.root;
    openTab({ type: "analysis", title: gameTitle(g), game: { ...g, cursor: at }, orientation: r.orientation ?? "white" });
  });
  return { opened: Math.min(games.length, max) };
}

/** The game a Lichess page shows (game, study, puzzle) with the cursor on this position, if it has it. */
export async function findInGame(url: string | undefined, fen: string): Promise<GameState | null> {
  if (!url || !/^https?:\/\/([\w-]+\.)*lichess\.org\//i.test(url)) return null;
  try {
    const r = await loadLink(url);
    const same = (a: string, b: string, n: number) => a.split(" ").slice(0, n).join(" ") === b.split(" ").slice(0, n).join(" ");
    for (const g of parsePgnText(r.pgn ?? "")) {
      const ids = [...mainline(g), ...Object.keys(g.nodes)];
      // the side to move is a guess from the highlighted last move: fall back to the placement alone
      const at = ids.find((id) => same(g.nodes[id].fen, fen, 2)) ?? ids.find((id) => same(g.nodes[id].fen, fen, 1));
      if (at) return { ...g, cursor: at };
    }
  } catch {
    // not a game page (or offline)
  }
  return null;
}

/** Paste handler and import box: a link, a PGN or a FEN. */
export const importAny = (text: string) => (looksLikeLink(text) ? importLink(text) : Promise.resolve(importText(text)));

// ------------------------------------------------------------ dialog

function BrowserExtension() {
  return (
    <Stack gap={6}>
      <Text size="sm" fw={600}>Firefox extension</Text>
      <Text size="xs" c="dimmed">
        Follows any board on Lichess live: moves played, moves you step through, a new game. Add the firefox-extension folder of this
        project (see the README), then open a board on Lichess. It opens here by itself, one tab per Firefox tab. Stop it here, or
        for all boards from the extension's toolbar button. Games you are playing yourself are not sent until they end.
      </Text>
    </Stack>
  );
}

export function ImportModal() {
  const open = useUi((s) => s.importOpen);
  const setOpen = useUi((s) => s.setImportOpen);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const run = async (t: string) => {
    setLoading(true);
    const r = await importAny(t);
    setLoading(false);
    if (r.opened) {
      setOpen(false);
      setText("");
      setError(null);
    } else setError(r.error ?? null);
  };

  return (
    <Modal opened={open} onClose={() => setOpen(false)} title="Import game" size="lg" centered>
      <Stack>
        <Textarea autosize minRows={8} maxRows={18} value={text} onChange={(e) => setText(e.currentTarget.value)}
          placeholder={'Paste a PGN, a FEN or a Lichess link (game, study, analysis, puzzle)\n\nhttps://lichess.org/abcd1234/black#32\n\n[Event "..."]\n1. e4 e5 2. Nf3 ...'}
          styles={{ input: { fontFamily: "monospace" } }} />
        {error && <Alert color="orange" p="xs"><Text size="sm">{error}</Text></Alert>}
        <Group justify="space-between">
          <FileButton accept=".pgn,.txt,application/x-chess-pgn" onChange={async (f) => f && run(await f.text())}>
            {(props) => <Button variant="default" leftSection={<IconFileUpload size={16} />} {...props}>Open PGN file</Button>}
          </FileButton>
          <Button onClick={() => run(text)} disabled={!text.trim()} loading={loading}>Import</Button>
        </Group>
        <Divider />
        <BrowserExtension />
      </Stack>
    </Modal>
  );
}
