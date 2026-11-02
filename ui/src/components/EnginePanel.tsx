import { useState } from "react";
import {
  ActionIcon, Badge, Group, Loader, MultiSelect, NumberInput, Paper, Popover, SegmentedControl, Select, Stack, Switch, Text, Tooltip,
} from "@mantine/core";
import { IconSettings } from "@tabler/icons-react";
import { formatScore } from "../chess/eval";
import { playUci, plyOf } from "../chess/position";
import type { AnalysisResult, EngineLine } from "../engine/useAnalysis";
import type { EngineInfo } from "../lib/api";
import { engineSettingsFor, useSettings, type EngineLimit } from "../store/settings";
import { figurine } from "./MoveList";
import type { Preview } from "./MiniBoard";

export function fenAfter(fen: string, ucis: string[]): { fen: string; last?: string } {
  let cur = fen;
  let last: string | undefined;
  for (const u of ucis) {
    const p = playUci(cur, u);
    if (!p) break;
    cur = p.fen;
    last = p.uci;
  }
  return { fen: cur, last };
}

function formatNodes(n?: number) {
  if (!n) return "0";
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "G";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(0) + "k";
  return String(n);
}

function EngineSettingsPopover({ engine }: { engine: EngineInfo }) {
  const all = useSettings((s) => s.engineSettings);
  const update = useSettings((s) => s.setEngineSettings);
  const s = engineSettingsFor(all, engine.id);
  const threadsMax = engine.options?.Threads?.max ?? 256;
  const hashMax = Math.min(engine.options?.Hash?.max ?? 65536, 65536);
  const setLimit = (patch: Partial<EngineLimit>) => update(engine.id, { limit: { ...s.limit, ...patch } });
  return (
    <Popover width={280} position="bottom-end" shadow="md" withArrow>
      <Popover.Target>
        <ActionIcon variant="subtle" color="gray" aria-label="Engine settings">
          <IconSettings size={16} />
        </ActionIcon>
      </Popover.Target>
      <Popover.Dropdown>
        <Stack gap="xs">
          <Text size="sm" fw={600}>{engine.name}</Text>
          <div>
            <Text size="xs" c="dimmed" mb={2}>Lines</Text>
            <SegmentedControl fullWidth size="xs" value={String(s.multipv)} data={["1", "2", "3", "4", "5"]}
              onChange={(v) => update(engine.id, { multipv: Number(v) })} />
          </div>
          <Group grow>
            <NumberInput size="xs" label="Threads" min={1} max={threadsMax} value={s.threads}
              onChange={(v) => update(engine.id, { threads: Number(v) || 1 })} />
            <NumberInput size="xs" label="Hash (MB)" min={1} max={hashMax} step={64} value={s.hash}
              onChange={(v) => update(engine.id, { hash: Number(v) || 16 })} />
          </Group>
          <Group grow align="end">
            <Select size="xs" label="Search" value={s.limit.type} allowDeselect={false}
              data={[{ value: "infinite", label: "Infinite" }, { value: "depth", label: "Depth" }, { value: "time", label: "Seconds" }, { value: "nodes", label: "Nodes" }]}
              onChange={(v) => setLimit({ type: v as EngineLimit["type"], value: v === "depth" ? 24 : v === "time" ? 10 : v === "nodes" ? 5_000_000 : undefined })} />
            {s.limit.type !== "infinite" && (
              <NumberInput size="xs" min={1} value={s.limit.value} onChange={(v) => setLimit({ value: Number(v) || 1 })} />
            )}
          </Group>
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}

function LineRow({ line, fen, onPlay, setPreview }: {
  line: EngineLine; fen: string; onPlay: (ucis: string[]) => void; setPreview: (p: Preview | null) => void;
}) {
  const fig = useSettings((s) => s.figurine);
  const ply = plyOf(fen);
  const s = line.score;
  const positive = s.mate !== undefined ? (s.mate === 0 ? s.winner === "white" : s.mate > 0) : (s.cp ?? 0) >= 0;
  return (
    <div className="engine-line">
      <span className={`score-badge ${positive ? "pos" : "neg"}`}>{formatScore(s)}</span>
      <div className="engine-pv">
        {line.san.map((san, i) => {
          const moverPly = ply + i;
          const white = moverPly % 2 === 0;
          const num = Math.floor(moverPly / 2) + 1;
          return (
            <span
              key={i}
              className="pv-move"
              onClick={() => onPlay(line.pv.slice(0, i + 1))}
              onMouseEnter={(e) => {
                const after = fenAfter(fen, line.pv.slice(0, i + 1));
                setPreview({ fen: after.fen, lastMove: after.last, x: e.clientX, y: e.clientY });
              }}
              onMouseLeave={() => setPreview(null)}
            >
              {(white || i === 0) && <span className="move-num">{num}{white ? "." : "..."}</span>}
              {fig ? figurine(san) : san}
            </span>
          );
        })}
      </div>
    </div>
  );
}

export function EnginePanel({ engines, results, active, onToggle, fen, onPlayLine, setPreview }: {
  engines: EngineInfo[];
  results: Record<string, AnalysisResult>;
  active: boolean;
  onToggle: (on: boolean) => void;
  fen: string;
  onPlayLine: (ucis: string[]) => void;
  setPreview: (p: Preview | null) => void;
}) {
  const selected = useSettings((s) => s.analysisEngines);
  const set = useSettings((s) => s.set);
  const all = useSettings((s) => s.engineSettings);
  const [showPicker, setShowPicker] = useState(false);
  const shown = engines.filter((e) => selected.includes(e.id));
  const list = shown.length ? shown : engines.slice(0, 1);

  if (!engines.length)
    return <Text size="sm" c="dimmed" p="sm">No engine found. Add a UCI engine on the Engines page.</Text>;

  return (
    <Stack gap="xs">
      <Group justify="space-between">
        <Switch checked={active} onChange={(e) => onToggle(e.currentTarget.checked)} label={active ? "Engine on" : "Engine off"} />
        <Tooltip label="Choose engines">
          <Badge variant="light" style={{ cursor: "pointer" }} onClick={() => setShowPicker((x) => !x)}>
            {list.length} engine{list.length > 1 ? "s" : ""}
          </Badge>
        </Tooltip>
      </Group>
      {showPicker && (
        <MultiSelect size="xs" data={engines.map((e) => ({ value: e.id, label: e.name }))} value={list.map((e) => e.id)}
          onChange={(v) => v.length && set({ analysisEngines: v })} placeholder="Engines" />
      )}
      {list.map((engine) => {
        const r = results[engine.id];
        const s = engineSettingsFor(all, engine.id);
        return (
          <Paper key={engine.id} withBorder p="xs" radius="md" className="engine-card">
            <Group justify="space-between" wrap="nowrap" mb={4}>
              <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
                {active && r && !r.done && <Loader size={12} />}
                <Text size="sm" fw={600} truncate>{engine.name}</Text>
              </Group>
              <Group gap={8} wrap="nowrap">
                {r?.depth !== undefined && (
                  <Text size="xs" c="dimmed">
                    depth {r.depth}{r.seldepth ? `/${r.seldepth}` : ""} · {formatNodes(r.nodes)} nodes · {formatNodes(r.nps)}/s
                  </Text>
                )}
                <EngineSettingsPopover engine={engine} />
              </Group>
            </Group>
            {r?.error && <Text size="xs" c="red">{r.error}</Text>}
            {r?.gameOver && <Text size="sm" c="dimmed">Game over ({r.gameOver})</Text>}
            {!r && active && <Text size="xs" c="dimmed">Starting…</Text>}
            {!r && !active && <Text size="xs" c="dimmed">Turn the engine on to see the best moves ({s.multipv} line{s.multipv > 1 ? "s" : ""}).</Text>}
            {r?.lines.map((l) => <LineRow key={l.multipv} line={l} fen={fen} onPlay={onPlayLine} setPreview={setPreview} />)}
          </Paper>
        );
      })}
    </Stack>
  );
}
