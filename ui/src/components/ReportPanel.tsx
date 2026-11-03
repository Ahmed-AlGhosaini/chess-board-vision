import { Button, Group, NumberInput, Paper, Progress, SimpleGrid, Stack, Switch, Table, Text } from "@mantine/core";
import { IconReportAnalytics, IconX } from "@tabler/icons-react";
import type { MoveClass } from "../chess/eval";
import { cancelReport, startReport } from "../engine/report";
import { useSettings } from "../store/settings";
import type { Tab } from "../store/tabs";
import { EvalGraph } from "./EvalGraph";

const CLASS_ROWS: { cls: MoveClass; label: string; color: string }[] = [
  { cls: "best", label: "Best", color: "#26c2a3" },
  { cls: "excellent", label: "Excellent", color: "#5c8bb0" },
  { cls: "good", label: "Good", color: "#82a96b" },
  { cls: "inaccuracy", label: "Inaccuracy", color: "#e6b800" },
  { cls: "mistake", label: "Mistake", color: "#e69d00" },
  { cls: "blunder", label: "Blunder", color: "#df5353" },
];

export function ReportPanel({ tab, onSelect }: { tab: Tab; onSelect: (id: string) => void }) {
  const depth = useSettings((s) => s.reportDepth);
  const variations = useSettings((s) => s.reportVariations);
  const set = useSettings((s) => s.set);
  const r = tab.report;
  const moves = Object.keys(tab.game.nodes).length > 1;
  const live = tab.type === "live";

  const counts = (white: boolean) => {
    const c: Partial<Record<MoveClass, number>> = {};
    if (!r?.classes) return c;
    r.nodeIds.slice(1).forEach((id, i) => {
      const startWhite = tab.game.nodes[r.nodeIds[0]]?.fen.split(" ")[1] === "w";
      const isWhite = (i % 2 === 0) === startWhite;
      const cls = r.classes![id];
      if (cls && isWhite === white) c[cls] = (c[cls] ?? 0) + 1;
    });
    return c;
  };

  return (
    <Stack gap="sm">
      {live && (!r || !r.accuracy) && (
        <Text size="sm" c="dimmed">
          Every move of the live game is evaluated as it arrives (depth set in Settings): accuracy and move classes appear here,
          and inaccuracies, mistakes and blunders are marked in the move list.
        </Text>
      )}
      {live && r?.status === "live" && r.progress < r.total && (
        <Text size="xs" c="dimmed">Evaluating: {r.progress} / {r.total} positions</Text>
      )}
      {!live && (!r || r.status === "error") && (
        <Paper withBorder p="sm" radius="md">
          <Text size="sm" mb="xs">
            Analyse every move of the main line: accuracy for both sides, inaccuracies, mistakes and blunders,
            with the engine's better line added as a variation.
          </Text>
          {r?.error && <Text size="xs" c="red" mb="xs">{r.error}</Text>}
          <Group align="end">
            <NumberInput label="Depth per move" size="xs" min={6} max={30} w={120} value={depth} onChange={(v) => set({ reportDepth: Number(v) || 16 })} />
            <Switch size="xs" label="Add best lines" checked={variations} onChange={(e) => set({ reportVariations: e.currentTarget.checked })} mb={6} />
          </Group>
          <Button mt="sm" leftSection={<IconReportAnalytics size={16} />} disabled={!moves} onClick={() => startReport(tab.id)}>
            Generate report
          </Button>
        </Paper>
      )}
      {r?.status === "running" && (
        <Paper withBorder p="sm" radius="md">
          <Group justify="space-between" mb={6}>
            <Text size="sm">Analysing position {r.progress} / {r.total}</Text>
            <Button size="compact-xs" variant="subtle" color="red" leftSection={<IconX size={12} />} onClick={() => cancelReport(tab.id)}>Cancel</Button>
          </Group>
          <Progress value={(100 * r.progress) / Math.max(1, r.total)} animated />
        </Paper>
      )}
      {(r?.status === "done" || r?.status === "live") && r.accuracy && (
        <Paper withBorder p="sm" radius="md">
          <SimpleGrid cols={2} mb="sm">
            {(["white", "black"] as const).map((side) => (
              <div key={side} className={`accuracy-card ${side}`}>
                <Text size="xs" tt="uppercase" c="dimmed">{tab.game.headers[side === "white" ? "White" : "Black"]?.replace("?", "") || side}</Text>
                <Text size="xl" fw={700}>{r.accuracy![side].toFixed(1)}%</Text>
                <Text size="xs" c="dimmed">accuracy · ACPL {Math.round(r.cpl?.[side] ?? 0)}</Text>
              </div>
            ))}
          </SimpleGrid>
          <Table withRowBorders={false} verticalSpacing={2} fz="sm">
            <Table.Tbody>
              {CLASS_ROWS.map(({ cls, label, color }) => (
                <Table.Tr key={cls}>
                  <Table.Td ta="center" w={60}>{counts(true)[cls] ?? 0}</Table.Td>
                  <Table.Td ta="center" style={{ color, fontWeight: 600 }}>{label}</Table.Td>
                  <Table.Td ta="center" w={60}>{counts(false)[cls] ?? 0}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
          {!live && (
            <Group justify="flex-end" mt="xs">
              <Button size="compact-xs" variant="subtle" onClick={() => startReport(tab.id)}>Run again</Button>
            </Group>
          )}
        </Paper>
      )}
      <EvalGraph game={tab.game} onSelect={onSelect} />
    </Stack>
  );
}
