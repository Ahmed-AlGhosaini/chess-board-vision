import { useEffect, useRef, useState } from "react";
import { Alert, Anchor, Badge, Button, Group, Paper, SegmentedControl, Stack, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconFocus2, IconPlayerStop, IconPlayerTrackNext, IconRefresh, IconScreenShare } from "@tabler/icons-react";
import { fenError, type Color } from "../chess/position";
import { captureCanvas, redetect, resumeCapture, unmatchedPlacement } from "../live/capture";
import { isWatching, lastId, patchLive, resetGame, startLichessWatch, stopWatch } from "../live/watch";
import { useTabs, type LiveStatus, type Tab } from "../store/tabs";
import { editorToFen, possibleCastling } from "./BoardEditor";

const STATUS: Record<LiveStatus, { label: string; color: string }> = {
  connecting: { label: "Connecting…", color: "gray" },
  live: { label: "LIVE", color: "red" },
  reconnecting: { label: "Reconnecting…", color: "yellow" },
  ended: { label: "Game over", color: "blue" },
  "lost-sync": { label: "Lost track", color: "orange" },
  stopped: { label: "Stopped", color: "gray" },
  error: { label: "Error", color: "red" },
};

/** Status and controls of a live tab, above the analysis panels. */
export function LivePanel({ tab }: { tab: Tab }) {
  const updateGame = useTabs((s) => s.updateGame);
  const [busy, setBusy] = useState(false);
  const live = tab.live!;
  const g = tab.game;
  const atEnd = g.cursor === lastId(g);
  const watching = isWatching(tab.id) && live.status !== "error";
  const st = STATUS[live.status];

  const reconnect = async () => {
    if (live.source === "lichess") return startLichessWatch(tab.id);
    setBusy(true);
    try {
      const err = await resumeCapture(tab.id);
      if (err) notifications.show({ color: "orange", title: "Could not start the capture", message: err });
    } catch (e: any) {
      if (e?.name !== "NotAllowedError") notifications.show({ color: "red", message: e.message || String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Paper withBorder p="sm" radius="md">
      <Stack gap="xs">
        <Group justify="space-between" wrap="nowrap">
          <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
            <Badge color={st.color} variant={live.status === "live" ? "filled" : "light"}
              leftSection={live.status === "live" ? <span className="live-dot" /> : undefined}>{st.label}</Badge>
            {live.source === "capture" ? (
              <Text size="sm" c="dimmed">Screen capture</Text>
            ) : (
              <Anchor size="sm" href={liveLink(live.url, live.game)} target="_blank" truncate>
                {live.url?.includes("/tv") ? "Lichess TV" : "Lichess"}
              </Anchor>
            )}
          </Group>
          <Group gap={4} wrap="nowrap">
            {!atEnd && (
              <Button size="compact-xs" variant="light" leftSection={<IconPlayerTrackNext size={12} />}
                onClick={() => updateGame(tab.id, (x) => ({ ...x, cursor: lastId(x) }))}>
                Jump to live
              </Button>
            )}
            {watching ? (
              <Button size="compact-xs" variant="default" leftSection={<IconPlayerStop size={12} />} onClick={() => stopWatch(tab.id)}>Stop</Button>
            ) : live.status !== "ended" && (
              <Button size="compact-xs" leftSection={live.source === "capture" ? <IconScreenShare size={12} /> : <IconRefresh size={12} />}
                loading={busy} onClick={reconnect}>
                {live.source === "capture" ? "Share screen again" : "Reconnect"}
              </Button>
            )}
          </Group>
        </Group>
        {live.status === "ended" && (
          <Text size="sm"><b>{g.headers.Result}</b>{live.reason ? ` · ${live.reason}` : ""}</Text>
        )}
        {live.error && <Alert color={live.status === "error" ? "red" : "orange"} p="xs">{live.error}</Alert>}
        {live.status === "lost-sync" && <LostTrack tab={tab} />}
        {live.source === "capture" && watching && <CapturePreview tabId={tab.id} status={live.status} />}
      </Stack>
    </Paper>
  );
}

function liveLink(url?: string, game?: string): string {
  if (!url) return "https://lichess.org";
  const full = url.includes("://") ? url : url.length <= 12 && !url.includes("/") ? `https://lichess.org/${url}` : `https://${url}`;
  // a broadcast round picked from the list: link straight to the game
  return game && full.includes("/broadcast/") && !full.replace(/\/$/, "").endsWith(game) ? `${full.replace(/\/$/, "")}/${game}` : full;
}

async function findBoard(tabId: string) {
  const err = await redetect(tabId).catch((e) => e.message as string);
  notifications.show(err ? { color: "orange", message: err } : { message: "Board found again" });
}

/** The capture saw a board that does not follow from the game: offer to start from it. */
function LostTrack({ tab }: { tab: Tab }) {
  const [turn, setTurn] = useState<Color>("white");
  const restart = () => {
    const placement = unmatchedPlacement(tab.id);
    if (!placement) return;
    const fen = editorToFen({ placement, turn, castling: possibleCastling(placement) });
    const problem = fenError(fen);
    if (problem) return notifications.show({ color: "orange", title: "The board on screen is not a legal position", message: problem });
    resetGame(tab.id, fen, { ...tab.game.headers, Result: "*" });
    patchLive(tab.id, { status: "live" });
  };
  return (
    <Alert color="orange" p="xs" title="The board on screen no longer follows from this game">
      <Text size="xs">
        A few moves were missed, the board is covered, or a new game started. Start again from the position on screen, or find the board
        again if it moved.
      </Text>
      <Group gap="xs" mt={6}>
        <SegmentedControl size="xs" value={turn} onChange={(v) => setTurn(v as Color)}
          data={[{ value: "white", label: "White to move" }, { value: "black", label: "Black to move" }]} />
        <Button size="compact-xs" onClick={restart} disabled={!unmatchedPlacement(tab.id)}>Restart from screen</Button>
        <Button size="compact-xs" variant="default" leftSection={<IconFocus2 size={12} />} onClick={() => findBoard(tab.id)}>Find board</Button>
      </Group>
    </Alert>
  );
}

/** What the capture currently sees: its board crop, refreshed by the capture loop. */
function CapturePreview({ tabId, status }: { tabId: string; status: LiveStatus }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const c = captureCanvas(tabId);
    if (!c || !ref.current) return;
    c.className = "capture-preview";
    ref.current.appendChild(c);
    return () => c.remove();
  }, [tabId, status]);
  return (
    <Group gap="sm" align="flex-start" wrap="nowrap">
      <div ref={ref} className="capture-preview-holder" />
      <Stack gap={6}>
        <Text size="xs" c="dimmed">The board as captured. It is read whenever it changes and then holds still.</Text>
        <Button size="compact-xs" variant="default" leftSection={<IconFocus2 size={12} />} onClick={() => findBoard(tabId)}>Find board again</Button>
      </Stack>
    </Group>
  );
}
