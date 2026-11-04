import { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert, Badge, Button, Grid, Group, Modal, ScrollArea, SegmentedControl, Stack, Table, Tabs, Text, TextInput, ThemeIcon,
} from "@mantine/core";
import {
  IconAlertTriangle, IconBroadcast, IconCrop, IconDeviceTv, IconEye, IconRefresh, IconScreenShare,
} from "@tabler/icons-react";
import type { Key } from "chessground/types";
import { fenError } from "../chess/position";
import { newGame } from "../chess/tree";
import { api } from "../lib/api";
import { captureSupported, detectBoard, grabFrame, shareScreen, startCapture, type FrameSource, type VisionResult } from "../live/capture";
import { tabSource } from "../live/tabFrames";
import { startLichessWatch } from "../live/watch";
import { useTabs, type LiveState } from "../store/tabs";
import { useUi } from "../store/ui";
import { BoardBox } from "./BoardBox";
import { BoardEditor, editorToFen, possibleCastling, START_PLACEMENT, type EditorState } from "./BoardEditor";
import { detectedTurn, gridToPlacement, squareAt, squareHighlights, TurnNote, UNSURE } from "./ScreenshotImport";

interface Resolved {
  kind: "game" | "tv" | "broadcast";
  round?: string;
  game?: string | null;
  roundName?: string;
  tourName?: string;
  games?: { id: string; name: string; status: string; players: { name: string; title?: string; rating?: number }[] }[];
}

const TV_CHANNELS = [
  { url: "https://lichess.org/tv", label: "Top rated" },
  { url: "https://lichess.org/tv/blitz", label: "Blitz" },
  { url: "https://lichess.org/tv/rapid", label: "Rapid" },
  { url: "https://lichess.org/tv/classical", label: "Classical" },
];

export function LiveSetup() {
  const open = useUi((s) => s.liveOpen);
  const setOpen = useUi((s) => s.setLiveOpen);
  const offer = useUi((s) => s.tabOffer);
  const [mode, setMode] = useState<string | null>("lichess");
  const close = () => setOpen(false);
  useEffect(() => {
    if (offer) setMode("capture"); // a tab chosen in the extension is set up like a shared screen
  }, [offer]);
  return (
    <Modal opened={open} onClose={close} centered size={mode === "capture" ? "min(1180px, 96vw)" : "lg"}
      title={<Group gap="xs"><IconBroadcast size={20} /><Text fw={600}>Watch a live game</Text></Group>}>
      <Tabs value={mode} onChange={setMode} keepMounted={false}>
        <Tabs.List mb="md">
          <Tabs.Tab value="lichess" leftSection={<IconBroadcast size={14} />}>Lichess</Tabs.Tab>
          <Tabs.Tab value="capture" leftSection={<IconScreenShare size={14} />}>Screen capture</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="lichess"><LichessForm onDone={close} /></Tabs.Panel>
        <Tabs.Panel value="capture"><CaptureForm onDone={close} /></Tabs.Panel>
      </Tabs>
    </Modal>
  );
}

function LichessForm({ onDone }: { onDone: () => void }) {
  const openTab = useTabs((s) => s.openTab);
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [round, setRound] = useState<(Resolved & { url: string }) | null>(null);

  const start = (live: Partial<LiveState>, title: string) => {
    const id = openTab({ type: "live", title, analysisOn: true, live: { source: "lichess", status: "connecting", ...live } });
    startLichessWatch(id);
    onDone();
  };

  const go = async (text: string) => {
    setLoading(true);
    setError(null);
    setRound(null);
    try {
      const r = await api<Resolved>(`/api/live/resolve?url=${encodeURIComponent(text)}`);
      if (r.kind === "broadcast" && !r.game) {
        if (r.games?.length) setRound({ ...r, url: text });
        else setError("This round has no games yet. Try again when it has started.");
      } else start({ url: text, round: r.round, game: r.game ?? undefined }, r.kind === "tv" ? "Lichess TV" : "Live game");
    } catch (e: any) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  };

  const player = (p?: { name: string; title?: string; rating?: number }) =>
    p ? `${p.title ? p.title + " " : ""}${p.name}${p.rating ? ` (${p.rating})` : ""}` : "?";

  return (
    <Stack>
      <Text size="sm" c="dimmed">
        Paste a link to a game being played on Lichess, a broadcast round (top tournaments) or Lichess TV. Moves appear as they are
        played; the engine follows the newest move and every move is classified (inaccuracy, mistake, blunder) as it comes in.
      </Text>
      <Group align="end" wrap="nowrap">
        <TextInput style={{ flex: 1 }} label="Lichess link" placeholder="https://lichess.org/abcd1234  or  https://lichess.org/broadcast/…"
          value={url} onChange={(e) => setUrl(e.currentTarget.value)} onKeyDown={(e) => e.key === "Enter" && url.trim() && void go(url)} data-autofocus />
        <Button leftSection={<IconEye size={16} />} loading={loading} disabled={!url.trim()} onClick={() => go(url)}>Watch</Button>
      </Group>
      <Group gap="xs">
        <ThemeIcon variant="light" size="sm"><IconDeviceTv size={14} /></ThemeIcon>
        <Text size="sm">Lichess TV:</Text>
        {TV_CHANNELS.map((c) => (
          <Button key={c.url} size="compact-sm" variant="light" disabled={loading} onClick={() => go(c.url)}>{c.label}</Button>
        ))}
      </Group>
      {error && <Alert color="red" icon={<IconAlertTriangle size={16} />}>{error}</Alert>}
      {round && (
        <Stack gap={4}>
          <Text size="sm" fw={600}>{round.tourName} · {round.roundName}: pick a game</Text>
          <ScrollArea.Autosize mah={340} type="auto">
            <Table highlightOnHover verticalSpacing={4} fz="sm">
              <Table.Tbody>
                {round.games!.map((g) => (
                  <Table.Tr key={g.id} style={{ cursor: "pointer" }} onClick={() => start({ url: round.url, round: round.round, game: g.id }, g.name || "Broadcast")}>
                    <Table.Td>{player(g.players[0])}</Table.Td>
                    <Table.Td>{player(g.players[1])}</Table.Td>
                    <Table.Td ta="right">{g.status === "*" ? <Badge size="xs" color="red">live</Badge> : <Text size="xs" c="dimmed">{g.status}</Text>}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </ScrollArea.Autosize>
        </Stack>
      )}
      <Text size="xs" c="dimmed">
        Lichess shows games to spectators with a short delay, and broadcasts arrive as fast as the tournament relays them.
        To follow a board you already have open in Firefox, tick its tab under the chessvision extension's toolbar button.
      </Text>
    </Stack>
  );
}

function CaptureForm({ onDone }: { onDone: () => void }) {
  const openTab = useTabs((s) => s.openTab);
  const offer = useUi((s) => s.tabOffer);
  const setTabOffer = useUi((s) => s.setTabOffer);
  const [source, setSource] = useState<FrameSource | null>(null);
  const started = useRef(false);
  const [frame, setFrame] = useState<Blob | null>(null);
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const [result, setResult] = useState<VisionResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cropMode, setCropMode] = useState(false);
  const [whiteAtBottom, setWhiteAtBottom] = useState(true);
  const [editor, setEditor] = useState<EditorState | null>(null);

  // stop sharing when the dialog closes without starting (or another window is shared)
  useEffect(() => () => {
    if (!started.current) source?.stop();
  }, [source]);
  useEffect(() => {
    if (!frame) return setFrameUrl(null);
    const u = URL.createObjectURL(frame);
    setFrameUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [frame]);

  const read = async (blob: Blob, bbox?: number[]) => {
    setLoading(true);
    setError(null);
    try {
      const r = bbox
        ? await api<VisionResult>(`/api/vision/recognize?bbox=${bbox.map((v) => Math.round(v)).join(",")}`,
          { method: "POST", body: blob, headers: { "Content-Type": "application/octet-stream" } })
        : await detectBoard(blob);
      setResult(r);
      if (r.ok && r.grid) {
        const wab = !!r.whiteAtBottom;
        setWhiteAtBottom(wab);
        const placement = gridToPlacement(r.grid, wab);
        setEditor((e) => ({
          placement, turn: placement === START_PLACEMENT ? "white" : (detectedTurn(r) ?? e?.turn ?? "white"), castling: possibleCastling(placement),
        }));
        setCropMode(false);
      } else {
        setEditor(null);
        setCropMode(true);
      }
    } catch (e: any) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  };

  const snap = async (s: FrameSource | null = source) => {
    if (!s) return;
    const blob = await grabFrame(s);
    setFrame(blob);
    await read(blob);
  };

  const adopt = async (s: FrameSource) => {
    setSource(s);
    s.onEnded(() => {
      if (started.current) return;
      setSource(null);
      setFrame(null);
      setResult(null);
      setEditor(null);
    });
    await snap(s);
  };

  const share = async () => {
    setError(null);
    try {
      await adopt(await shareScreen());
    } catch (e: any) {
      if (e?.name !== "NotAllowedError") setError(e.message || String(e)); // NotAllowedError = the user cancelled
    }
  };

  useEffect(() => {
    if (!offer) return;
    void tabSource(offer).then((s) => (s ? adopt(s) : setTabOffer(null))).catch((e) => setError(e.message || String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offer]);

  const setOrientation = (wab: boolean) => {
    setWhiteAtBottom(wab);
    if (result?.grid && editor) {
      const placement = gridToPlacement(result.grid, wab);
      setEditor({ ...editor, placement, castling: possibleCastling(placement) });
    }
  };

  const unsure = useMemo(() => {
    const out: { row: number; col: number; key: Key }[] = [];
    result?.confidence?.forEach((row, r) => row.forEach((c, col) => {
      if (c < UNSURE) out.push({ row: r, col, key: squareAt(r, col, whiteAtBottom) });
    }));
    return out;
  }, [result, whiteAtBottom]);
  const highlight = useMemo(() => squareHighlights(result, unsure, whiteAtBottom), [result, unsure, whiteAtBottom]);

  const fen = editor ? editorToFen(editor) : null;
  const problem = fen ? fenError(fen) : null;

  const start = () => {
    if (!fen || problem || !source || !result?.bbox) return;
    started.current = true;
    const id = openTab({
      type: "live", title: source.title || "Screen capture", analysisOn: true, orientation: whiteAtBottom ? "white" : "black",
      game: newGame(fen, { Event: "Screen capture" }), live: { source: "capture", status: "live", session: source.session, url: source.url },
    });
    startCapture(id, source, result.bbox, whiteAtBottom);
    setTabOffer(null);
    onDone();
  };

  if (!source && !offer && !captureSupported()) {
    return <Alert color="orange" icon={<IconAlertTriangle size={16} />}>This browser cannot share its screen with a page.</Alert>;
  }

  if (!source) {
    return (
      <Stack align="flex-start">
        <Text size="sm" c="dimmed">
          Follow a game shown anywhere on your screen: a stream on Twitch or YouTube, Chess.com, another app. Share the window or browser
          tab with the board; the app finds the board, reads it whenever it changes and works out the moves played.
          Works with 2D boards seen straight on, like screenshots.
        </Text>
        <Button leftSection={<IconScreenShare size={16} />} onClick={share}>Choose a window or tab to share</Button>
        {error && <Alert color="red" icon={<IconAlertTriangle size={16} />}>{error}</Alert>}
        <Text size="xs" c="dimmed">
          The picture stays on this computer: frames go only to the local server. In Firefox, you can instead tick the tab under the
          chessvision extension's toolbar button, and it comes here without asking to share the screen.
        </Text>
      </Stack>
    );
  }

  return (
    <Grid gutter="lg">
      <Grid.Col span={{ base: 12, md: 6 }}>
        <Stack gap="xs">
          <Group justify="space-between">
            <Text size="sm" fw={600} truncate style={{ flex: 1, minWidth: 0 }}>{source.title ?? "Shared screen"}</Text>
            <Group gap={4}>
              <Button size="compact-xs" variant={cropMode ? "filled" : "default"} leftSection={<IconCrop size={12} />}
                onClick={() => setCropMode((c) => !c)} disabled={!result}>
                {cropMode ? "Drag a box around the board" : "Wrong area? Select the board"}
              </Button>
              <Button size="compact-xs" variant="default" leftSection={<IconRefresh size={12} />} onClick={() => snap()} disabled={loading}>New frame</Button>
            </Group>
          </Group>
          <BoardBox src={frameUrl} size={result ?? undefined} bbox={result?.bbox} unsure={unsure} cropMode={cropMode} loading={loading}
            onSelect={(box) => frame && void read(frame, box)} />
          {error && <Alert color="red" icon={<IconAlertTriangle size={16} />}>{error}</Alert>}
          {result && !result.ok && <Alert color="orange" icon={<IconAlertTriangle size={16} />}>{result.error}</Alert>}
          {result?.ok && (
            <Group gap="xs">
              <Text size="sm">Which side is at the bottom?</Text>
              <SegmentedControl size="xs" value={whiteAtBottom ? "white" : "black"} onChange={(v) => setOrientation(v === "white")}
                data={[{ value: "white", label: "White" }, { value: "black", label: "Black" }]} />
            </Group>
          )}
        </Stack>
      </Grid.Col>
      <Grid.Col span={{ base: 12, md: 6 }}>
        {editor ? (
          <Stack gap="xs">
            <Text size="sm" fw={600}>Starting position</Text>
            <div className="editor-holder">
              <BoardEditor value={editor} orientation={whiteAtBottom ? "white" : "black"} highlight={highlight} onChange={setEditor} />
            </div>
            {editor.placement !== START_PLACEMENT && <TurnNote result={result} turn={editor.turn} whiteAtBottom={whiteAtBottom} />}
            <Text size="xs" c="dimmed">
              Check the position and whose move it is. From here on, every change on screen is matched against the legal moves.
            </Text>
            {problem && <Text size="xs" c="red">{problem}</Text>}
            <Group>
              <Button leftSection={<IconEye size={16} />} onClick={start} disabled={!!problem || !result?.bbox}>Start watching</Button>
            </Group>
          </Stack>
        ) : (
          <Stack align="center" justify="center" h="100%" mih={300} c="dimmed">
            <IconScreenShare size={48} stroke={1} />
            <Text size="sm" ta="center">
              {loading ? "Locating the board…" : "Select the board on the shared screen, or bring it into view and take a new frame."}
            </Text>
          </Stack>
        )}
      </Grid.Col>
    </Grid>
  );
}
