import { useCallback, useEffect, useState } from "react";
import {
  ActionIcon, Button, Card, FileButton, Group, Modal, NumberInput, Pagination, Progress, ScrollArea, SegmentedControl, Select, SimpleGrid, Stack,
  Table, Text, TextInput, Title, Tooltip,
} from "@mantine/core";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import { IconCloudDownload, IconDatabase, IconFileImport, IconPlus, IconSearch, IconTrash } from "@tabler/icons-react";
import { parsePgnText } from "../chess/pgn";
import { api, waitForJob, type Job } from "../lib/api";
import { useTabs } from "../store/tabs";
import { gameTitle } from "../components/ImportModal";

interface DbInfo {
  name: string;
  games: number;
  size: number;
  description: string;
}

interface GameRow {
  id: number;
  event: string;
  date: string;
  white: string;
  black: string;
  result: string;
  white_elo: number | null;
  black_elo: number | null;
  eco: string | null;
  opening: string | null;
  time_control: string | null;
  ply_count: number;
}

const PAGE = 50;
const fmtSize = (b: number) => (b > 1e9 ? (b / 1e9).toFixed(1) + " GB" : b > 1e6 ? (b / 1e6).toFixed(1) + " MB" : (b / 1e3).toFixed(0) + " KB");

export function DatabasesPage() {
  const [dbs, setDbs] = useState<DbInfo[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [download, setDownload] = useState(false);
  const [job, setJob] = useState<Job | null>(null);

  const refresh = useCallback(() => api<DbInfo[]>("/api/databases").then(setDbs).catch(() => setDbs([])), []);
  useEffect(() => void refresh(), [refresh]);

  const create = async () => {
    try {
      const db = await api<DbInfo>("/api/databases", { method: "POST", json: { name: newName } });
      setCreating(false);
      setNewName("");
      await refresh();
      setSelected(db.name);
    } catch (e: any) {
      notifications.show({ color: "red", message: e.message });
    }
  };

  const runJob = async (start: Promise<{ job: string }>) => {
    try {
      const { job: id } = await start;
      const done = await waitForJob(id, setJob);
      notifications.show({ color: "green", message: `${done.result} games imported` });
    } catch (e: any) {
      notifications.show({ color: "red", title: "Import failed", message: e.message });
    } finally {
      setJob(null);
      void refresh();
    }
  };

  const importFile = async (db: string, file: File | null) => {
    if (!file) return;
    runJob(api(`/api/databases/${encodeURIComponent(db)}/import`, { method: "POST", body: await file.text() }));
  };

  const remove = (db: string) =>
    modals.openConfirmModal({
      title: `Delete ${db}?`,
      children: <Text size="sm">This permanently deletes the database file and all its games.</Text>,
      labels: { confirm: "Delete", cancel: "Cancel" },
      confirmProps: { color: "red" },
      onConfirm: async () => {
        await api(`/api/databases/${encodeURIComponent(db)}`, { method: "DELETE" });
        if (selected === db) setSelected(null);
        void refresh();
      },
    });

  return (
    <div className="page">
      <Group justify="space-between" mb="md">
        <Title order={2}>Databases</Title>
        <Group>
          <Button variant="default" leftSection={<IconCloudDownload size={16} />} onClick={() => setDownload(true)}>Download my games</Button>
          <Button leftSection={<IconPlus size={16} />} onClick={() => setCreating(true)}>New database</Button>
        </Group>
      </Group>
      {job && (
        <Card withBorder mb="md">
          <Text size="sm" mb={4}>{job.label}: {job.message}</Text>
          <Progress value={job.progress * 100} animated />
        </Card>
      )}
      {!dbs.length && <Text c="dimmed">No databases yet. Create one, then import a PGN file or download your online games.</Text>}
      <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }} mb="lg">
        {dbs.map((db) => (
          <Card key={db.name} withBorder radius="md" className={`db-card ${selected === db.name ? "selected" : ""}`} onClick={() => setSelected(db.name)}>
            <Group justify="space-between" wrap="nowrap">
              <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
                <IconDatabase size={20} />
                <Text fw={600} truncate>{db.name}</Text>
              </Group>
              <Group gap={2} wrap="nowrap" onClick={(e) => e.stopPropagation()}>
                <FileButton accept=".pgn,.txt" onChange={(f) => importFile(db.name, f)}>
                  {(props) => <Tooltip label="Import PGN file"><ActionIcon variant="subtle" {...props}><IconFileImport size={16} /></ActionIcon></Tooltip>}
                </FileButton>
                <Tooltip label="Delete"><ActionIcon variant="subtle" color="red" onClick={() => remove(db.name)}><IconTrash size={16} /></ActionIcon></Tooltip>
              </Group>
            </Group>
            <Text size="sm" c="dimmed" mt={4}>{db.games.toLocaleString()} games · {fmtSize(db.size)}</Text>
          </Card>
        ))}
      </SimpleGrid>
      {selected && <GameTable key={selected} db={selected} />}

      <Modal opened={creating} onClose={() => setCreating(false)} title="New database" centered>
        <Stack>
          <TextInput label="Name" value={newName} onChange={(e) => setNewName(e.currentTarget.value)} data-autofocus
            onKeyDown={(e) => e.key === "Enter" && newName.trim() && create()} />
          <Group justify="flex-end"><Button onClick={create} disabled={!newName.trim()}>Create</Button></Group>
        </Stack>
      </Modal>
      <DownloadModal opened={download} onClose={() => setDownload(false)} dbs={dbs}
        onStart={(db, body) => {
          setDownload(false);
          runJob(api(`/api/databases/${encodeURIComponent(db)}/download`, { method: "POST", json: body }));
        }} />
    </div>
  );
}

function DownloadModal({ opened, onClose, dbs, onStart }: {
  opened: boolean; onClose: () => void; dbs: DbInfo[]; onStart: (db: string, body: object) => void;
}) {
  const [source, setSource] = useState("lichess");
  const [username, setUsername] = useState("");
  const [max, setMax] = useState<number>(300);
  const [db, setDb] = useState<string | null>(null);
  const start = async () => {
    let target = db;
    if (!target) {
      target = `${username} (${source === "lichess" ? "Lichess" : "Chess.com"})`.replace(/[^\w\- ]+/g, "");
      if (!dbs.some((d) => d.name === target)) await api("/api/databases", { method: "POST", json: { name: target } }).catch(() => {});
    }
    onStart(target, { source, username, max });
  };
  return (
    <Modal opened={opened} onClose={onClose} title="Download games from an online account" centered>
      <Stack>
        <SegmentedControl value={source} onChange={setSource} data={[{ value: "lichess", label: "Lichess" }, { value: "chesscom", label: "Chess.com" }]} />
        <TextInput label="Username" value={username} onChange={(e) => setUsername(e.currentTarget.value)} />
        <NumberInput label="Most recent games" min={1} max={5000} value={max} onChange={(v) => setMax(Number(v) || 100)} />
        <Select label="Into database" placeholder="New database named after the account" clearable data={dbs.map((d) => d.name)} value={db} onChange={setDb} />
        <Group justify="flex-end"><Button onClick={start} disabled={!username.trim()} leftSection={<IconCloudDownload size={16} />}>Download</Button></Group>
      </Stack>
    </Modal>
  );
}

function GameTable({ db }: { db: string }) {
  const openTab = useTabs((s) => s.openTab);
  const [player, setPlayer] = useState("");
  const [event, setEvent] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ total: number; games: GameRow[] }>({ total: 0, games: [] });

  const load = useCallback(() => {
    const q = new URLSearchParams({ player, event, result: result ?? "", offset: String((page - 1) * PAGE), limit: String(PAGE) });
    api(`/api/databases/${encodeURIComponent(db)}/games?${q}`).then(setData).catch(() => {});
  }, [db, player, event, result, page]);
  useEffect(() => {
    const t = setTimeout(load, 200);
    return () => clearTimeout(t);
  }, [load]);

  const open = async (id: number) => {
    const g = await api(`/api/databases/${encodeURIComponent(db)}/games/${id}`);
    const game = parsePgnText(g.pgn)[0];
    if (game) openTab({ type: "analysis", title: gameTitle(game), game, source: `database: ${db}` });
  };

  const del = async (id: number) => {
    await api(`/api/databases/${encodeURIComponent(db)}/games/${id}`, { method: "DELETE" });
    load();
  };

  return (
    <Card withBorder radius="md">
      <Group mb="sm" align="end">
        <TextInput label="Player" leftSection={<IconSearch size={14} />} value={player} onChange={(e) => { setPlayer(e.currentTarget.value); setPage(1); }} />
        <TextInput label="Event" value={event} onChange={(e) => { setEvent(e.currentTarget.value); setPage(1); }} />
        <Select label="Result" clearable data={["1-0", "0-1", "1/2-1/2"]} value={result} onChange={(v) => { setResult(v); setPage(1); }} w={120} />
        <Text size="sm" c="dimmed" ml="auto">{data.total.toLocaleString()} games</Text>
      </Group>
      <ScrollArea>
        <Table highlightOnHover striped fz="sm">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>White</Table.Th><Table.Th>Black</Table.Th><Table.Th>Result</Table.Th><Table.Th>Date</Table.Th>
              <Table.Th>Event</Table.Th><Table.Th>Opening</Table.Th><Table.Th>Moves</Table.Th><Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {data.games.map((g) => (
              <Table.Tr key={g.id} style={{ cursor: "pointer" }} onClick={() => open(g.id)}>
                <Table.Td>{g.white} {g.white_elo ? <Text span c="dimmed" size="xs">{g.white_elo}</Text> : null}</Table.Td>
                <Table.Td>{g.black} {g.black_elo ? <Text span c="dimmed" size="xs">{g.black_elo}</Text> : null}</Table.Td>
                <Table.Td>{g.result}</Table.Td>
                <Table.Td>{g.date?.replace(/\.\?\?/g, "")}</Table.Td>
                <Table.Td><Text size="sm" truncate maw={200}>{g.event}</Text></Table.Td>
                <Table.Td><Text size="sm" truncate maw={240}>{[g.eco, g.opening].filter(Boolean).join(" ")}</Text></Table.Td>
                <Table.Td>{Math.ceil(g.ply_count / 2)}</Table.Td>
                <Table.Td onClick={(e) => e.stopPropagation()}>
                  <ActionIcon size="sm" variant="subtle" color="red" onClick={() => del(g.id)}><IconTrash size={14} /></ActionIcon>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </ScrollArea>
      {data.total > PAGE && <Group justify="center" mt="sm"><Pagination total={Math.ceil(data.total / PAGE)} value={page} onChange={setPage} /></Group>}
    </Card>
  );
}
