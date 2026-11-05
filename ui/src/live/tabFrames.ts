import { useTabs } from "../store/tabs";
import { useUi } from "../store/ui";
import { resumeCapture, type FrameSource } from "./capture";
import { patchLive } from "./watch";

/*
 * A browser tab chosen in the extension (firefox-extension/), sent as pictures: the same as
 * sharing that tab's screen, but for where the frames come from. A newly chosen tab goes to
 * the capture dialog, to check the position before watching; one whose live tab is still
 * here goes straight back to it.
 */

export interface FramePush {
  session: string;
  seq: number;
  image: string; // a JPEG data URL
  title: string;
  url: string;
  stop?: boolean;
}

interface Session {
  seq: number;
  seen: number; // Date.now() of the last message
  latest: string; // the last picture that arrived
  shown: string; // the one in `picture`
  decoded: number; // how many pictures there have been
  onDecoded?: () => void;
  decoding: boolean;
  picture: HTMLImageElement;
  title: string;
  url: string;
  owner: FrameSource | null; // who is reading the pictures: the dialog or a capture
  held: boolean; // the dialog was closed or Stop pressed: leave it alone while the tab stays chosen
  ended: (() => void)[];
}

const STALE_MS = 20_000; // the extension repeats a picture every 5 seconds
const sessions = new Map<string, Session>();

async function decode(s: Session) {
  if (s.decoding) return;
  s.decoding = true;
  try {
    while (s.shown !== s.latest) {
      const url = s.latest;
      const img = new Image();
      img.src = url;
      await img.decode();
      s.shown = url;
      s.picture = img;
      s.decoded++;
      s.onDecoded?.();
    }
  } catch (e) {
    s.shown = s.latest; // the next picture will do
    console.warn("tab frames:", e);
  } finally {
    s.decoding = false;
  }
}

/** The frames of a chosen tab, or null if the extension is not sending it any more. */
export async function tabSource(session: string): Promise<FrameSource | null> {
  const s = sessions.get(session);
  if (!s) return null;
  const source: FrameSource = {
    get image() {
      return s.picture;
    },
    size: () => [s.picture.naturalWidth, s.picture.naturalHeight],
    frames: () => s.decoded,
    onFrame: (f) => {
      s.onDecoded = f;
    },
    onEnded: (f) => s.ended.push(f),
    stop: () => {
      if (s.owner !== source) return;
      s.owner = null;
      s.onDecoded = undefined;
      s.held = true;
      s.ended = [];
      clearOffer(session);
    },
    session, title: s.title, url: s.url,
  };
  s.owner = source;
  s.held = false;
  await decode(s);
  return source;
}

function clearOffer(session: string) {
  const ui = useUi.getState();
  if (ui.tabOffer === session) ui.setTabOffer(null);
}

/** Nothing reads this tab yet: its live tab if it has one, else the dialog. */
function claim(session: string) {
  const tab = useTabs.getState().tabs.find((t) => t.live?.session === session && t.live.status !== "ended");
  if (!tab) return useUi.getState().setTabOffer(session);
  void tabSource(session)
    .then((source) => (source ? resumeCapture(tab.id, source) : null))
    .then((error) => {
      if (error) patchLive(tab.id, { status: "stopped", error });
    })
    .catch((e) => patchLive(tab.id, { status: "stopped", error: String(e?.message || e) }));
}

function end(session: string, s: Session) {
  sessions.delete(session);
  clearOffer(session);
  const ended = s.ended;
  s.ended = [];
  s.owner = null;
  ended.forEach((f) => f());
}

/** Handle one message from the extension. */
export function onFramePush(p: FramePush) {
  let s = sessions.get(p.session);
  if (!s) {
    if (p.stop) return;
    s = { seq: 0, seen: 0, latest: "", shown: "", decoded: 0, decoding: false, picture: new Image(), title: "", url: "", owner: null, held: false, ended: [] };
    sessions.set(p.session, s);
  }
  if (p.seq <= s.seq) return; // requests can overtake each other
  s.seq = p.seq;
  s.seen = Date.now();
  if (p.stop) return end(p.session, s);
  s.latest = p.image;
  s.title = p.title;
  s.url = p.url;
  if (s.owner) void decode(s);
  else if (!s.held && !useUi.getState().tabOffer) claim(p.session);
}

export const framesKnown = (session?: string) => !!session && sessions.has(session);

// the extension went away: nothing says so except the silence
setInterval(() => {
  for (const [session, s] of sessions) {
    if (Date.now() - s.seen < STALE_MS) continue;
    end(session, s);
    const tab = useTabs.getState().tabs.find((t) => t.live?.session === session);
    if (tab?.live?.status === "stopped") patchLive(tab.id, { error: "The Firefox tab stopped sending pictures. To follow it again, tick it under the extension's toolbar button." });
  }
}, 10_000);
