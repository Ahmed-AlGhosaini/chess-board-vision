import { useEffect, useRef, useState } from "react";
import { Alert, Group, Loader, Select, Stack, Table, Text, Tooltip } from "@mantine/core";
import { IconAlertCircle } from "@tabler/icons-react";
import { api } from "../lib/api";
import { useSettings } from "../store/settings";
import { figurine } from "./MoveList";

interface ExplorerMove {
  uci: string;
  san: string;
  total: number;
  white: number;
  draws: number;
  black: number;
  avg?: number;
}

interface ExplorerGame {
  id: string;
  white: string;
  black: string;
  whiteElo?: number;
  blackElo?: number;
  result: string;
  year?: string | number;
}

interface ExplorerData {
  opening?: string;
  total: number;
  white: number;
  draws: number;
  black: number;
  moves: ExplorerMove[];
  games: ExplorerGame[];
}

const cache = new Map<string, ExplorerData>();

async function fetchExplorer(source: string, fen: string): Promise<ExplorerData> {
  const key = `${source}|${fen}`;
  if (cache.has(key)) return cache.get(key)!;
  let data: ExplorerData;
  if (source.startsWith("db:")) {
    const r = await api(`/api/databases/${encodeURIComponent(source.slice(3))}/explore?fen=${encodeURIComponent(fen)}`);
    data = {
      total: r.total, white: r.white, draws: r.draws, black: r.black,
      moves: r.moves.map((m: any) => ({ uci: m.uci, san: m.san, total: m.games, white: m.white, draws: m.draws, black: m.black })),
      games: r.games.map((g: any) => ({ id: String(g.id), white: g.white, black: g.black, whiteElo: g.white_elo, blackElo: g.black_elo, result: g.result, year: g.date?.slice(0, 4) })),
    };
  } else {
    const q = new URLSearchParams({ fen, moves: "15", topGames: "8" });
    if (source === "lichess") {
      q.set("variant", "standard");
      q.set("speeds", "blitz,rapid,classical");
      q.set("ratings", "1800,2000,2200,2500");
      q.set("recentGames", "0");
    }
    const r = await api(`/api/lichess/explorer/${source}?${q}`);
    const games = [...(r.topGames ?? []), ...(r.recentGames ?? [])];
    data = {
      opening: r.opening ? `${r.opening.eco} ${r.opening.name}` : undefined,
      total: r.white + r.draws + r.black, white: r.white, draws: r.draws, black: r.black,
      moves: r.moves.map((m: any) => ({ uci: m.uci, san: m.san, total: m.white + m.draws + m.black, white: m.white, draws: m.draws, black: m.black, avg: m.averageRating })),
      games: games.map((g: any) => ({
        id: g.id, white: g.white.name, black: g.black.name, whiteElo: g.white.rating, blackElo: g.black.rating,
        result: g.winner === "white" ? "1-0" : g.winner === "black" ? "0-1" : "½-½", year: g.year,
      })),
    };
  }
  cache.set(key, data);
  return data;
}

function WdlBar({ white, draws, black }: { white: number; draws: number; black: number }) {
  const t = Math.max(1, white + draws + black);
  const pct = (x: number) => (100 * x) / t;
  const label = (x: number) => (pct(x) >= 12 ? `${Math.round(pct(x))}%` : "");
  return (
    <div className="wdl-bar">
      <div className="w" style={{ width: `${pct(white)}%` }}>{label(white)}</div>
      <div className="d" style={{ width: `${pct(draws)}%` }}>{label(draws)}</div>
      <div className="b" style={{ width: `${pct(black)}%` }}>{label(black)}</div>
    </div>
  );
}

const fmt = (n: number) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n));

export function ExplorerPanel({ fen, onMove, onHover, onOpenGame }: {
  fen: string;
  onMove: (uci: string) => void;
  onHover: (uci: string | null) => void;
  onOpenGame: (source: string, id: string) => void;
}) {
  const source = useSettings((s) => s.explorerSource);
  const fig = useSettings((s) => s.figurine);
  const set = useSettings((s) => s.set);
  const [dbs, setDbs] = useState<{ value: string; label: string }[]>([]);
  const [data, setData] = useState<ExplorerData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const req = useRef(0);

  useEffect(() => {
    api<{ name: string; games: number }[]>("/api/databases")
      .then((list) => setDbs(list.map((d) => ({ value: `db:${d.name}`, label: `${d.name} (${d.games} games)` }))))
      .catch(() => setDbs([]));
  }, []);

  useEffect(() => {
    const id = ++req.current;
    setLoading(true);
    const t = setTimeout(() => {
      fetchExplorer(source, fen)
        .then((d) => {
          if (id !== req.current) return;
          setData(d);
          setError(null);
        })
        .catch((e) => {
          if (id !== req.current) return;
          setData(null);
          setError(e.status === 401
            ? "The Lichess explorer needs a Lichess API token. Add one in Settings, or pick a local database."
            : String(e.message || e));
        })
        .finally(() => id === req.current && setLoading(false));
    }, 200);
    return () => clearTimeout(t);
  }, [fen, source]);

  return (
    <Stack gap="xs">
      <Group justify="space-between" wrap="nowrap">
        <Select size="xs" value={source} allowDeselect={false} onChange={(v) => v && set({ explorerSource: v })} w={260}
          data={[
            { group: "Lichess (online)", items: [{ value: "masters", label: "Masters" }, { value: "lichess", label: "Lichess players" }] },
            { group: "Local databases", items: dbs.length ? dbs : [{ value: "none", label: "No databases yet", disabled: true }] },
          ]} />
        {loading && <Loader size="xs" />}
      </Group>
      {data?.opening && <Text size="sm" fw={600}>{data.opening}</Text>}
      {error && <Alert color="orange" icon={<IconAlertCircle size={16} />} p="xs">{error}</Alert>}
      {data && !data.moves.length && !error && <Text size="sm" c="dimmed">No games reached this position.</Text>}
      {data && data.moves.length > 0 && (
        <Table highlightOnHover verticalSpacing={3} fz="sm" className="explorer-table">
          <Table.Thead>
            <Table.Tr>
              <Table.Th w={70}>Move</Table.Th>
              <Table.Th w={90}>Games</Table.Th>
              <Table.Th>White / Draw / Black</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {data.moves.map((m) => (
              <Table.Tr key={m.uci} style={{ cursor: "pointer" }} onClick={() => onMove(m.uci)}
                onMouseEnter={() => onHover(m.uci)} onMouseLeave={() => onHover(null)}>
                <Table.Td fw={600}>{fig ? figurine(m.san) : m.san}</Table.Td>
                <Table.Td>
                  <Tooltip label={m.avg ? `Average rating ${m.avg}` : `${m.total} games`} openDelay={500}>
                    <span>{fmt(m.total)} <Text span size="xs" c="dimmed">{Math.round((100 * m.total) / Math.max(1, data.total))}%</Text></span>
                  </Tooltip>
                </Table.Td>
                <Table.Td><WdlBar {...m} /></Table.Td>
              </Table.Tr>
            ))}
            <Table.Tr>
              <Table.Td fw={600}>Σ</Table.Td>
              <Table.Td>{fmt(data.total)}</Table.Td>
              <Table.Td><WdlBar {...data} /></Table.Td>
            </Table.Tr>
          </Table.Tbody>
        </Table>
      )}
      {data && data.games.length > 0 && (
        <>
          <Text size="xs" c="dimmed" tt="uppercase" fw={600} mt="xs">Top games</Text>
          <Table highlightOnHover verticalSpacing={2} fz="xs">
            <Table.Tbody>
              {data.games.map((g) => (
                <Table.Tr key={g.id} style={{ cursor: "pointer" }} onClick={() => onOpenGame(source, g.id)}>
                  <Table.Td>{g.white} {g.whiteElo ? <Text span c="dimmed" size="xs">({g.whiteElo})</Text> : null}</Table.Td>
                  <Table.Td>{g.black} {g.blackElo ? <Text span c="dimmed" size="xs">({g.blackElo})</Text> : null}</Table.Td>
                  <Table.Td ta="center">{g.result}</Table.Td>
                  <Table.Td c="dimmed">{g.year}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </>
      )}
    </Stack>
  );
}
