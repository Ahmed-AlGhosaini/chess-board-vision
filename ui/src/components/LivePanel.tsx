import { useEffect, useRef, useState } from "react";
import { Alert, Anchor, Badge, Button, Group, Paper, Stack, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconFocus2, IconPlayerStop, IconPlayerTrackNext, IconRefresh, IconScreenShare } from "@tabler/icons-react";
import { fenError, turnOf } from "../chess/position";
import { captureCanvas, followedNode, redetect, resumeCapture } from "../live/capture";
import { pageKnown, resumePage } from "../live/pageWatch";
import { framesKnown, tabSource } from "../live/tabFrames";
import { isWatching, lastId, resetGame, startLichessWatch, stopWatch } from "../live/watch";
import { useTabs, type LiveStatus, type Tab } from "../store/tabs";

const STATUS: Record<LiveStatus, { label: string; color: string }> = {
  connecting: { label: "Connecting…", color: "gray" },
  live: { label: "LIVE", color: "red" },
  reconnecting: { label: "Reconnecting…", color: "yellow" },
  ended: { label: "Game over", color: "blue" },
  "lost-sync": { label: "Board not visible", color: "orange" },
  stopped: { label: "Stopped", color: "gray" },
  error: { label: "Error", color: "red" },
};

/** Status and controls of a live tab, above the analysis panels. */
export function LivePanel({ tab }: { tab: Tab }) {
  const updateGame = useTabs((s) => s.updateGame);
  const [busy, setBusy] = useState(false);
  const live = tab.live!;
  const g = tab.game;
  const liveNode = followedNode(tab.id) ?? lastId(g); // a screen can be showing a variation
  const atEnd = g.cursor === liveNode;
  const watching = isWatching(tab.id) && live.status !== "error";
  const st = STATUS[live.status];
  const fromExtension = !!live.session; // the extension sends this tab, rather than a screen shared here
  const extensionKnows = live.source === "page" ? pageKnown(live.session) : framesKnown(live.session);

  const reconnect = async () => {
    if (live.source === "lichess") return startLichessWatch(tab.id);
    if (live.source === "page") return void resumePage(tab.id);
    setBusy(true);
    try {
      const source = fromExtension ? await tabSource(live.session!) : undefined;
      if (source === null) return;
      const err = await resumeCapture(tab.id, source);
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
              fromExtension && live.url
                ? <Anchor size="sm" href={live.url} target="_blank" truncate>Firefox tab</Anchor>
                : <Text size="sm" c="dimmed">Screen capture</Text>
            ) : live.source === "page" ? (
              live.url ? <Anchor size="sm" href={live.url} target="_blank" truncate>Lichess page</Anchor> : <Text size="sm" c="dimmed">Lichess page</Text>
            ) : (
              <Anchor size="sm" href={liveLink(live.url, live.game)} target="_blank" truncate>
                {live.url?.includes("/tv") ? "Lichess TV" : "Lichess"}
              </Anchor>
            )}
          </Group>
          <Group gap={4} wrap="nowrap">
            {!atEnd && live.source !== "page" && (
              <Button size="compact-xs" variant="light" leftSection={<IconPlayerTrackNext size={12} />}
                onClick={() => updateGame(tab.id, (x) => ({ ...x, cursor: liveNode }))}>
                Jump to live
              </Button>
            )}
            {watching ? (
              <Button size="compact-xs" variant="default" leftSection={<IconPlayerStop size={12} />} onClick={() => stopWatch(tab.id)}>Stop</Button>
            ) : live.status !== "ended" && (!fromExtension || extensionKnows) && (
              <Button size="compact-xs" leftSection={live.source === "capture" && !fromExtension ? <IconScreenShare size={12} /> : <IconRefresh size={12} />}
                loading={busy} onClick={reconnect}>
                {fromExtension ? "Follow again" : live.source === "capture" ? "Share screen again" : "Reconnect"}
              </Button>
            )}
          </Group>
        </Group>
        {live.status === "ended" && (
          <Text size="sm"><b>{g.headers.Result}</b>{live.reason ? ` · ${live.reason}` : ""}</Text>
        )}
        {fromExtension && live.status !== "ended" && !watching && !live.error && !extensionKnows && (
          <Text size="xs" c="dimmed">
            To follow it again, tick that Firefox tab under the extension's toolbar button{live.source === "page" ? ", with a board open on Lichess" : ""}.
          </Text>
        )}
        {live.error && <Alert color={live.status === "error" ? "red" : "orange"} p="xs">{live.error}</Alert>}
        {live.status === "lost-sync" && <NotVisible tabId={tab.id} />}
        {live.source === "capture" && watching && !g.nodes[g.root].children.length && <SideToMove tab={tab} />}
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

/** The picture shows no position: the board stays where it was until it shows one again. */
function NotVisible({ tabId }: { tabId: string }) {
  return (
    <Alert color="orange" p="xs" title="No board on screen right now">
      <Text size="xs">
        The picture does not read as a chess position: the board may be covered or have moved. Following carries on by itself as soon as
        the board can be read, and the board is looked for elsewhere on the screen meanwhile.
      </Text>
      <Button size="compact-xs" variant="default" mt={6} leftSection={<IconFocus2 size={12} />} onClick={() => findBoard(tabId)}>Find board now</Button>
    </Alert>
  );
}

/** A picture rarely shows for certain whose move it is: at the start of a game, it can be put right. */
function SideToMove({ tab }: { tab: Tab }) {
  const g = tab.game;
  const fen = g.nodes[g.root].fen;
  const other = fen.replace(/ [wb] /, (m) => (m === " w " ? " b " : " w "));
  if (fenError(other)) return null;
  return (
    <Group gap="xs">
      <Text size="xs" c="dimmed">{turnOf(fen) === "white" ? "White" : "Black"} to move</Text>
      <Button size="compact-xs" variant="default" onClick={() => resetGame(tab.id, other, g.headers.Event ? { Event: g.headers.Event } : {})}>Switch side</Button>
    </Group>
  );
}

/** What the capture currently sees: its board crop, refreshed at each read. */
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
        <Text size="xs" c="dimmed">The board as captured. It is read as soon as it changes, and the board here follows it, whatever is played.</Text>
        <Button size="compact-xs" variant="default" leftSection={<IconFocus2 size={12} />} onClick={() => findBoard(tabId)}>Find board again</Button>
      </Stack>
    </Group>
  );
}
