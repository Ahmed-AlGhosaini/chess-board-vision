import { useState } from "react";
import { Alert, Button, FileButton, Group, Modal, Stack, Text, Textarea } from "@mantine/core";
import { IconFileUpload } from "@tabler/icons-react";
import { completeFen, looksLikeFen, parsePgnText } from "../chess/pgn";
import { fenError } from "../chess/position";
import { newGame, type GameState } from "../chess/tree";
import { useTabs } from "../store/tabs";
import { useUi } from "../store/ui";

export function gameTitle(g: GameState): string {
  const w = g.headers.White && g.headers.White !== "?" ? g.headers.White : "";
  const b = g.headers.Black && g.headers.Black !== "?" ? g.headers.Black : "";
  return w || b ? `${w || "?"} – ${b || "?"}` : "Analysis";
}

/** Open PGN games (or a FEN) as analysis tabs. Returns the number of tabs opened, or an error. */
export function importText(text: string, max = 20): { opened: number; error?: string } {
  const { openTab } = useTabs.getState();
  const t = text.trim();
  if (!t) return { opened: 0, error: "Nothing to import" };
  if (looksLikeFen(t)) {
    const fen = completeFen(t);
    const err = fenError(fen);
    if (err) return { opened: 0, error: `FEN: ${err}` };
    openTab({ type: "analysis", title: "Position", game: newGame(fen), orientation: fen.split(" ")[1] === "b" ? "black" : "white" });
    return { opened: 1 };
  }
  const games = parsePgnText(t);
  if (!games.length) return { opened: 0, error: "No readable game found. Paste a PGN or a FEN." };
  for (const g of games.slice(0, max)) openTab({ type: "analysis", title: gameTitle(g), game: g });
  return { opened: Math.min(games.length, max), error: games.length > max ? `Opened the first ${max} of ${games.length} games. Import large files into a database instead.` : undefined };
}

export function ImportModal() {
  const open = useUi((s) => s.importOpen);
  const setOpen = useUi((s) => s.setImportOpen);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  const run = (t: string) => {
    const r = importText(t);
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
          placeholder={'Paste a PGN or a FEN here\n\n[Event "..."]\n1. e4 e5 2. Nf3 ...'} styles={{ input: { fontFamily: "monospace" } }} />
        {error && <Alert color="orange" p="xs"><Text size="sm">{error}</Text></Alert>}
        <Group justify="space-between">
          <FileButton accept=".pgn,.txt,application/x-chess-pgn" onChange={async (f) => f && run(await f.text())}>
            {(props) => <Button variant="default" leftSection={<IconFileUpload size={16} />} {...props}>Open PGN file</Button>}
          </FileButton>
          <Button onClick={() => run(text)} disabled={!text.trim()}>Import</Button>
        </Group>
      </Stack>
    </Modal>
  );
}
