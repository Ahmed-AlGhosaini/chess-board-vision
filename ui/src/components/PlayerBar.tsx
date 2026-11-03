import { useEffect, useState } from "react";
import { Group, Text } from "@mantine/core";
import { IconCpu, IconUser } from "@tabler/icons-react";
import { materialDiff, type Color } from "../chess/position";
import { Piece, type Role } from "./Piece";
import { useSettings } from "../store/settings";

export function formatClock(ms: number): string {
  const neg = ms < 0;
  ms = Math.max(0, ms);
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const tenths = ms < 10000 ? `.${Math.floor((ms % 1000) / 100)}` : "";
  const core = h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}${tenths}`;
  return neg ? "0:00" : core;
}

/** A clock face; with `since` (a Date.now() timestamp) it counts down from `ms` by itself. */
function Clock({ ms, running, since }: { ms: number; running?: boolean; since?: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (since === undefined) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(id);
  }, [since]);
  const left = since === undefined ? ms : ms - Math.max(0, now - since);
  return <div className={`clock ${running ? "running" : ""} ${left < 20000 ? "low" : ""}`}>{formatClock(left)}</div>;
}

/** Name, captured material and (optionally) a clock for one side. */
export function PlayerBar({ color, name, fen, clockMs, running, isEngine, tickingSince }: {
  color: Color; name: string; fen: string; clockMs?: number | null; running?: boolean; isEngine?: boolean;
  /** live games: the clock runs on its own from this moment (Date.now()) */
  tickingSince?: number;
}) {
  const showMaterial = useSettings((s) => s.showMaterial);
  const diff = materialDiff(fen);
  const mine = diff[color];
  const adv = color === "white" ? diff.score : -diff.score;
  const order: Role[] = ["queen", "rook", "bishop", "knight", "pawn"];
  const opp: Color = color === "white" ? "black" : "white";
  return (
    <Group className="player-bar" justify="space-between" wrap="nowrap" gap="xs">
      <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
        <span className={`color-dot ${color}`} />
        {isEngine ? <IconCpu size={16} /> : <IconUser size={16} />}
        <Text size="sm" fw={600} truncate>{name}</Text>
        {showMaterial && (
          <Group gap={0} wrap="nowrap" className="material">
            {order.flatMap((r) => Array.from({ length: mine[r] ?? 0 }, (_, i) => <Piece key={r + i} role={r} color={opp} size={16} style={{ marginRight: -4 }} />))}
            {adv > 0 && <Text size="xs" c="dimmed" ml={6}>+{adv}</Text>}
          </Group>
        )}
      </Group>
      {clockMs !== undefined && clockMs !== null && <Clock ms={clockMs} running={running || tickingSince !== undefined} since={tickingSince} />}
    </Group>
  );
}
