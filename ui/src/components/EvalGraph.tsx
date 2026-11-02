import { Area, AreaChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Text, useComputedColorScheme } from "@mantine/core";
import { chartValue, formatScore } from "../chess/eval";
import { mainline, type GameState } from "../chess/tree";

/** White-advantage graph over the main line; click a point to jump there. */
export function EvalGraph({ game, onSelect, height = 120 }: { game: GameState; onSelect: (id: string) => void; height?: number }) {
  const scheme = useComputedColorScheme("dark");
  const data = mainline(game)
    .map((id) => game.nodes[id])
    .map((n) => ({ id: n.id, ply: n.ply, value: chartValue(n.score), score: n.score, san: n.san }));
  const known = data.filter((d) => d.value !== null);
  if (known.length < 2) return <Text size="xs" c="dimmed">Generate a report to see the evaluation graph.</Text>;
  const cursorPly = game.nodes[game.cursor].ply;
  const values = known.map((d) => d.value as number);
  const max = Math.max(...values, 0.01);
  const min = Math.min(...values, -0.01);
  const zero = max / (max - min); // gradient stop where the line crosses 0
  const whiteFill = scheme === "dark" ? "#e8e8e8" : "#ffffff";
  const blackFill = scheme === "dark" ? "#1a1b1e" : "#4a4a4a";
  return (
    <div className="eval-graph" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 4, right: 4, bottom: 4, left: 4 }}
          onClick={(e: any) => e?.activePayload?.[0] && onSelect(e.activePayload[0].payload.id)}>
          <defs>
            <linearGradient id="evalSplit" x1="0" y1="0" x2="0" y2="1">
              <stop offset={zero} stopColor={whiteFill} stopOpacity={1} />
              <stop offset={zero} stopColor={blackFill} stopOpacity={1} />
            </linearGradient>
          </defs>
          <XAxis dataKey="ply" hide />
          <YAxis domain={[-10, 10]} hide />
          <Tooltip
            cursor={{ stroke: "#888", strokeWidth: 1 }}
            content={({ active, payload }) => {
              const p = payload?.[0]?.payload;
              if (!active || !p) return null;
              const num = Math.floor((p.ply - 1) / 2) + 1;
              return (
                <div className="graph-tip">
                  {p.san ? `${num}${p.ply % 2 ? "." : "..."} ${p.san}` : "Start"} <b>{formatScore(p.score)}</b>
                </div>
              );
            }}
          />
          <ReferenceLine y={0} stroke="#888" strokeDasharray="3 3" />
          <ReferenceLine x={cursorPly} stroke="var(--mantine-primary-color-filled)" strokeWidth={2} />
          <Area type="monotone" dataKey="value" stroke="#888" strokeWidth={1} fill="url(#evalSplit)" isAnimationActive={false} connectNulls />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
