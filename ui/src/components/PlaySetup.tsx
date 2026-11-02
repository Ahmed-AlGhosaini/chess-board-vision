import { useEffect, useState } from "react";
import { Button, Group, Modal, SegmentedControl, Select, Slider, Stack, Text } from "@mantine/core";
import { IconPlayerPlay } from "@tabler/icons-react";
import { INITIAL_FEN, turnOf, type Color } from "../chess/position";
import { newGame } from "../chess/tree";
import { api, type EngineInfo } from "../lib/api";
import { useTabs } from "../store/tabs";
import { useUi } from "../store/ui";

const TIME_CONTROLS = [
  { value: "none", label: "Unlimited" },
  { value: "60+0", label: "1+0 Bullet" },
  { value: "180+2", label: "3+2 Blitz" },
  { value: "300+3", label: "5+3 Blitz" },
  { value: "600+0", label: "10+0 Rapid" },
  { value: "900+10", label: "15+10 Rapid" },
  { value: "1800+0", label: "30+0 Classical" },
];

export function PlaySetup() {
  const { open, fen, orientation } = useUi((s) => s.play);
  const close = useUi((s) => s.closePlay);
  const openTab = useTabs((s) => s.openTab);
  const [engines, setEngines] = useState<EngineInfo[]>([]);
  const [engine, setEngine] = useState<string | null>("stockfish");
  const [side, setSide] = useState<"white" | "black" | "random" | "human">("white");
  const [level, setLevel] = useState(4);
  const [tc, setTc] = useState("300+3");

  useEffect(() => {
    if (!open) return;
    api<EngineInfo[]>("/api/engines").then((l) => {
      setEngines(l);
      setEngine((e) => (l.some((x) => x.id === e) ? e : l[0]?.id ?? null));
    }).catch(() => {});
    if (orientation) setSide(orientation);
  }, [open, orientation]);

  const start = () => {
    const startFen = fen ?? INITIAL_FEN;
    const me: Color | null = side === "human" ? null : side === "random" ? (Math.random() < 0.5 ? "white" : "black") : side;
    const engineColor: Color | null = me ? (me === "white" ? "black" : "white") : null;
    const [base, inc] = tc === "none" ? [0, 0] : tc.split("+").map(Number);
    const clock = tc === "none" ? null : { initial: base * 1000, increment: inc * 1000 };
    const engineName = engines.find((e) => e.id === engine)?.name ?? "Engine";
    const headers = {
      Event: "Casual game", Date: new Date().toISOString().slice(0, 10).replace(/-/g, "."),
      White: engineColor === "white" ? `${engineName} (level ${level})` : "You",
      Black: engineColor === "black" ? `${engineName} (level ${level})` : engineColor ? "You" : "Player 2",
      ...(clock ? { TimeControl: `${base}+${inc}` } : {}),
    };
    openTab({
      type: "play", title: `vs ${engineColor ? engineName : "Human"}`, orientation: me ?? turnOf(startFen),
      game: newGame(startFen, headers), analysisOn: false,
      play: {
        engine: engine ?? "stockfish", level, engineColor, clock,
        times: { white: clock?.initial ?? 0, black: clock?.initial ?? 0 }, status: "playing",
      },
    });
    close();
  };

  return (
    <Modal opened={open} onClose={close} title="Play against the engine" centered>
      <Stack>
        {fen && fen !== INITIAL_FEN && <Text size="sm" c="dimmed">Starting from the imported position ({turnOf(fen)} to move).</Text>}
        <div>
          <Text size="sm" mb={4}>You play</Text>
          <SegmentedControl fullWidth value={side} onChange={(v) => setSide(v as typeof side)}
            data={[{ value: "white", label: "White" }, { value: "random", label: "Random" }, { value: "black", label: "Black" }, { value: "human", label: "Both (2 players)" }]} />
        </div>
        {side !== "human" && (
          <>
            <Select label="Engine" data={engines.map((e) => ({ value: e.id, label: e.name }))} value={engine} onChange={setEngine} allowDeselect={false} />
            <div>
              <Text size="sm" mb={4}>Strength: level {level}</Text>
              <Slider min={1} max={8} step={1} value={level} onChange={setLevel} marks={[1, 2, 3, 4, 5, 6, 7, 8].map((v) => ({ value: v, label: String(v) }))} mb="md" />
            </div>
          </>
        )}
        <Select label="Time control" data={TIME_CONTROLS} value={tc} onChange={(v) => setTc(v ?? "none")} allowDeselect={false} />
        <Group justify="flex-end">
          <Button leftSection={<IconPlayerPlay size={16} />} onClick={start} disabled={side !== "human" && !engine}>Start game</Button>
        </Group>
      </Stack>
    </Modal>
  );
}
