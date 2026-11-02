import { useEffect, useState } from "react";
import { ActionIcon, Anchor, Button, CopyButton, Group, Select, SimpleGrid, Stack, Text, TextInput, Textarea, Tooltip } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconCheck, IconCopy, IconDatabasePlus, IconDownload, IconExternalLink } from "@tabler/icons-react";
import { toPgn } from "../chess/pgn";
import type { GameState } from "../chess/tree";
import { api } from "../lib/api";

const FIELDS: [string, string][] = [
  ["White", "White"], ["WhiteElo", "White Elo"], ["Black", "Black"], ["BlackElo", "Black Elo"],
  ["Event", "Event"], ["Site", "Site"], ["Date", "Date"], ["Round", "Round"], ["TimeControl", "Time control"], ["ECO", "ECO"],
];

export function downloadText(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/x-chess-pgn" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function gameFileName(g: GameState) {
  const w = (g.headers.White || "white").replace(/[^\w-]+/g, "_");
  const b = (g.headers.Black || "black").replace(/[^\w-]+/g, "_");
  return `${w}_vs_${b}.pgn`.replace(/\?/g, "");
}

export function InfoPanel({ game, fen, onHeaders }: { game: GameState; fen: string; onHeaders: (h: Record<string, string>) => void }) {
  const pgn = toPgn(game);
  const [dbs, setDbs] = useState<string[]>([]);
  const [db, setDb] = useState<string | null>(null);
  useEffect(() => {
    api<{ name: string }[]>("/api/databases").then((l) => {
      setDbs(l.map((d) => d.name));
      setDb((cur) => cur ?? l[0]?.name ?? null);
    }).catch(() => {});
  }, []);

  const save = async () => {
    if (!db) return;
    try {
      await api(`/api/databases/${encodeURIComponent(db)}/games`, { method: "POST", body: pgn });
      notifications.show({ color: "green", message: `Saved to ${db}` });
    } catch (e: any) {
      notifications.show({ color: "red", title: "Could not save", message: e.message });
    }
  };

  return (
    <Stack gap="xs">
      <SimpleGrid cols={2} spacing="xs" verticalSpacing={4}>
        {FIELDS.map(([key, label]) => (
          <TextInput key={key} size="xs" label={label} value={game.headers[key] && game.headers[key] !== "?" ? game.headers[key] : ""}
            onChange={(e) => onHeaders({ ...game.headers, [key]: e.currentTarget.value || "?" })} />
        ))}
        <Select size="xs" label="Result" value={game.headers.Result || "*"} allowDeselect={false}
          data={["*", "1-0", "0-1", "1/2-1/2"]} onChange={(v) => onHeaders({ ...game.headers, Result: v || "*" })} />
      </SimpleGrid>
      <Group gap={4} wrap="nowrap" align="end">
        <TextInput size="xs" label="FEN" value={fen} readOnly style={{ flex: 1 }} styles={{ input: { fontFamily: "monospace" } }} />
        <CopyButton value={fen}>
          {({ copied, copy }) => (
            <Tooltip label={copied ? "Copied" : "Copy FEN"}>
              <ActionIcon variant="default" size="md" onClick={copy}>{copied ? <IconCheck size={14} /> : <IconCopy size={14} />}</ActionIcon>
            </Tooltip>
          )}
        </CopyButton>
      </Group>
      <Textarea size="xs" label="PGN" value={pgn} readOnly autosize minRows={4} maxRows={10} styles={{ input: { fontFamily: "monospace" } }} />
      <Group gap="xs">
        <CopyButton value={pgn}>
          {({ copied, copy }) => (
            <Button size="xs" variant="default" leftSection={copied ? <IconCheck size={14} /> : <IconCopy size={14} />} onClick={copy}>
              {copied ? "Copied" : "Copy PGN"}
            </Button>
          )}
        </CopyButton>
        <Button size="xs" variant="default" leftSection={<IconDownload size={14} />} onClick={() => downloadText(gameFileName(game), pgn)}>Download</Button>
        <Anchor size="xs" href={`https://lichess.org/analysis/standard/${fen.replace(/ /g, "_")}`} target="_blank">
          <Group gap={2}>Open position on Lichess <IconExternalLink size={12} /></Group>
        </Anchor>
      </Group>
      <Group gap="xs" align="end">
        <Select size="xs" label="Save to database" placeholder={dbs.length ? "Choose" : "Create one on the Databases page"}
          data={dbs} value={db} onChange={setDb} style={{ flex: 1 }} />
        <Button size="xs" leftSection={<IconDatabasePlus size={14} />} disabled={!db} onClick={save}>Save</Button>
      </Group>
      <Text size="xs" c="dimmed">{Object.keys(game.nodes).length - 1} moves in the tree, including variations.</Text>
    </Stack>
  );
}
