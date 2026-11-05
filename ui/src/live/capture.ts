import { boardFen, gameOutcome, movesBetween } from "../chess/position";
import { isOnMainline, knownNode, type GameState } from "../chess/tree";
import { api } from "../lib/api";
import { useTabs } from "../store/tabs";
import { lastId, patchLive, playFrom, registerCapture, resetGame, restoreGame, unregisterCapture } from "./watch";

/*
 * Screen capture as a live-game source: frames of a shared window or tab, or of a
 * browser tab sent by the extension (tabFrames.ts), are cropped to the board. As soon
 * as the board changes, the crop goes to the server, which reads it (only the squares
 * that changed) and looks for legal moves leading there from the position being followed.
 *
 * Moves are shown at once: a picture caught mid-animation matches no legal move, so
 * there is no need to wait for the board to settle. A picture that follows from no move
 * is believed once it has held still, and then the tab goes wherever the screen is: to
 * that position in the game if it has one, or else to a new game from there. The screen
 * is always right, whatever the moves that led to it; a commentator can step through a
 * game, jump around or set up something else. Games left this way are kept, so that
 * coming back to one of their positions brings back the game, with its moves.
 */

export type Box = [number, number, number, number]; // x, y, w, h in picture pixels

/** Where the frames come from. */
export interface FrameSource {
  image: HTMLVideoElement | HTMLImageElement; // always shows the current frame
  size: () => [number, number]; // of the current frame, zero until there is one
  frames?: () => number; // how many have arrived, for a source too slow to tell a still picture from the time alone
  onFrame?: (f: () => void) => void; // a source that sends frames now and then says when one is there, to look at it at once
  onEnded: (f: () => void) => void; // the other side stopped
  stop: () => void;
  session?: string; // a browser tab sent by the extension: its session, title and address
  title?: string;
  url?: string;
}

export interface VisionResult {
  ok: boolean;
  error?: string;
  width: number;
  height: number;
  bbox?: Box;
  grid?: (string | null)[][];
  confidence?: number[][];
  whiteAtBottom?: boolean;
  warnings?: string[];
  turn?: "w" | "b" | null; // read off the highlighted last move; null if the board shows none
  lastMove?: [number, number][] | null; // picture row/col of the highlighted squares
}

interface TrackResult {
  status: "same" | "moves" | "unknown";
  moves: string[];
  fen?: string | null; // unknown: the position on screen, null if the picture shows none
  placement: string;
  uncertain: string[];
  whiteAtBottom: boolean; // differs from what was asked when the view was found to be flipped
}

const TICK_MS = 100;
const THUMB = 32; // the board is compared between ticks as a 32x32 grey thumbnail (4x4 px per square)
// A move changes only 2-4 of the 64 squares, so changes are measured per square:
// a moved piece shifts its square's mean grey level by 25-40, video noise by 1-2.
const CHANGED = 6;
const REREAD_MS = 1000; // a read that changes nothing is cheap: also read every so often, in case a change went unnoticed
const HOLD_MS = 300; // a picture that follows from no move must hold still this long (with a newer frame showing the same)
const HOLD_LONG_MS = 800; // ... or this long, as a page that stands still sends no newer frames
const LOST_MS = 1500; // how long a picture may show no position before the tab says so
const DETECT_MS = 3000; // while it does, how often to look for the board elsewhere: it may have moved
const FAILS_SHOWN = 3; // failed reads in a row before the error is shown in the tab
const GAMES_KEPT = 8;

interface Session {
  source: FrameSource;
  box: Box;
  whiteAtBottom: boolean;
  crop: HTMLCanvasElement;
  thumb: CanvasRenderingContext2D;
  stopTicks: () => void;
  at: string; // the node showing what is on screen
  prev: Uint8ClampedArray | null; // thumbnail of the current frame
  frame: number; // and which frame that was, of a source that counts them
  changedAt: number; // when the picture last changed
  changedFrame: number; // and at which frame of the source
  sent: Uint8ClampedArray | null; // thumbnail last sent to the server
  busy: boolean;
  lastSent: number;
  pending?: TrackResult; // the last read, of the picture now showing, if it followed from no move
  unknownFen?: string | null; // the position such reads have been showing
  unknownSince: number; // since when
  lostSince: number; // since when the picture shows no position, 0 if it does
  detecting: boolean;
  lastDetect: number;
  failures: number; // reads in a row that failed (server error, network)
  games: GameState[]; // earlier games on this screen
}

const sessions = new Map<string, Session>();

export const captureSupported = () => !!navigator.mediaDevices?.getDisplayMedia;

/** Ask the browser to share a window or tab, and start playing it. */
export async function shareScreen(): Promise<FrameSource> {
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 15, max: 30 } }, audio: false });
  const v = await videoFor(stream);
  return {
    image: v,
    size: () => (v.readyState < 2 ? [0, 0] : [v.videoWidth, v.videoHeight]),
    onEnded: (f) => stream.getVideoTracks()[0]?.addEventListener("ended", f),
    stop: () => stream.getTracks().forEach((t) => t.stop()),
  };
}

/** A playing, detached <video> for a stream, once its first frame is available. */
async function videoFor(stream: MediaStream): Promise<HTMLVideoElement> {
  const v = document.createElement("video");
  v.muted = true;
  v.playsInline = true;
  v.srcObject = stream;
  await v.play();
  if (v.readyState < 2 || !v.videoWidth) await new Promise((r) => v.addEventListener("loadeddata", r, { once: true }));
  return v;
}

/** The whole current frame as a PNG. */
export function grabFrame(source: FrameSource): Promise<Blob> {
  const c = document.createElement("canvas");
  [c.width, c.height] = source.size();
  c.getContext("2d")!.drawImage(source.image, 0, 0);
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("Could not read the frame"))), "image/png"));
}

export function detectBoard(frame: Blob): Promise<VisionResult> {
  return api<VisionResult>("/api/vision/recognize", { method: "POST", body: frame, headers: { "Content-Type": "application/octet-stream" } });
}

function grey(rgba: Uint8ClampedArray): Uint8ClampedArray {
  const out = new Uint8ClampedArray(rgba.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = (rgba[4 * i] * 3 + rgba[4 * i + 1] * 6 + rgba[4 * i + 2]) / 10;
  return out;
}

/** The largest change of any square between two thumbnails (mean grey-level difference over the square). */
function diff(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  const k = THUMB / 8;
  let max = 0;
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      let d = 0;
      for (let y = 0; y < k; y++) {
        for (let x = 0; x < k; x++) {
          const i = (r * k + y) * THUMB + c * k + x;
          d += Math.abs(a[i] - b[i]);
        }
      }
      max = Math.max(max, d / (k * k));
    }
  }
  return max;
}

/** Calls `f` every `ms`, also while this page is in the background, where the browser slows down its own timers. */
function steadily(f: () => void, ms: number): () => void {
  try {
    const url = URL.createObjectURL(new Blob([`setInterval(() => postMessage(0), ${ms})`], { type: "text/javascript" }));
    const worker = new Worker(url);
    worker.onmessage = f;
    return () => {
      worker.terminate();
      URL.revokeObjectURL(url);
    };
  } catch {
    const timer = window.setInterval(f, ms);
    return () => clearInterval(timer);
  }
}

const tabOf = (tabId: string) => useTabs.getState().tabs.find((x) => x.id === tabId);

/** The screen is back to something that makes sense: leave any state that said otherwise. */
function settle(tabId: string, s: Session) {
  s.pending = s.unknownFen = undefined;
  s.lostSince = 0;
  const t = tabOf(tabId);
  if (!t?.live) return;
  const over = isOnMainline(t.game, s.at) ? gameOutcome(t.game.nodes[s.at].fen) : null;
  if (over) {
    if (t.live.status === "ended" && t.live.reason === over.reason) return;
    useTabs.getState().updateTab(tabId, (x) => ({ game: { ...x.game, headers: { ...x.game.headers, Result: over.result } } }));
    patchLive(tabId, { status: "ended", reason: over.reason });
  } else if (t.live.status === "lost-sync" || t.live.status === "ended") {
    if (t.live.status === "ended") useTabs.getState().updateTab(tabId, (x) => ({ game: { ...x.game, headers: { ...x.game.headers, Result: "*" } } }));
    patchLive(tabId, { status: "live", reason: undefined });
  }
}

function turnBoard(tabId: string, s: Session, whiteAtBottom: boolean) {
  if (s.whiteAtBottom === whiteAtBottom) return;
  s.whiteAtBottom = whiteAtBottom;
  useTabs.getState().updateTab(tabId, () => ({ orientation: whiteAtBottom ? "white" : "black" }));
}

async function read(tabId: string, s: Session) {
  const t = tabOf(tabId);
  if (!t) return;
  if (!t.game.nodes[s.at]) s.at = lastId(t.game); // the game was replaced by hand
  const fen = t.game.nodes[s.at].fen;
  const blob = await new Promise<Blob | null>((r) => s.crop.toBlob(r, "image/jpeg", 0.92));
  if (!blob) return;
  const q = new URLSearchParams({ fen, orientation: s.whiteAtBottom ? "white" : "black", session: tabId });
  const r = await api<TrackResult>(`/api/vision/track?${q}`, { method: "POST", body: blob, headers: { "Content-Type": "application/octet-stream" } });
  if (sessions.get(tabId) !== s) return; // stopped meanwhile
  if (s.failures >= FAILS_SHOWN) patchLive(tabId, { error: undefined });
  s.failures = 0;
  if (tabOf(tabId)?.game.nodes[s.at]?.fen !== fen) {
    s.sent = null; // the game changed while this frame was read (e.g. the side to move was switched): read again
    return;
  }
  if (r.status === "unknown") {
    if (r.fen !== s.unknownFen) {
      s.unknownFen = r.fen;
      s.unknownSince = performance.now();
    }
    s.pending = r;
    return;
  }
  turnBoard(tabId, s, r.whiteAtBottom);
  if (r.status === "moves") {
    const added = playFrom(tabId, s.at, r.moves.map((uci) => ({ uci })));
    if (added.length) s.at = added[added.length - 1];
  }
  settle(tabId, s);
}

/** The picture has held still, follows from no move, and shows this position: go there. */
function jumpTo(tabId: string, s: Session, fen: string) {
  const t = tabOf(tabId);
  if (!t) return;
  const g = t.game;
  const known = knownNode(g, fen, s.at);
  if (known) { // stepping back through the game
    const follow = g.cursor === s.at;
    s.at = known;
    if (follow) useTabs.getState().updateGame(tabId, (x) => ({ ...x, cursor: known }));
    return;
  }
  const end = lastId(g);
  const moves = end === s.at ? null : movesBetween(g.nodes[end].fen, boardFen(fen)); // back to the game after a detour
  if (moves) {
    if (g.cursor === s.at) useTabs.getState().updateGame(tabId, (x) => ({ ...x, cursor: end }));
    const added = playFrom(tabId, end, moves.map((uci) => ({ uci })));
    s.at = added.length ? added[added.length - 1] : end;
    return;
  }
  if (g.nodes[g.root].children.length) s.games = [g, ...s.games].slice(0, GAMES_KEPT);
  const earlier = s.games.findIndex((x) => x !== g && knownNode(x, fen));
  if (earlier >= 0) {
    const game = s.games[earlier];
    s.games = s.games.filter((x) => x !== game);
    s.at = knownNode(game, fen)!;
    restoreGame(tabId, { ...game, cursor: s.at });
    return;
  }
  resetGame(tabId, fen, g.headers.Event ? { Event: g.headers.Event } : {});
  s.at = tabOf(tabId)!.game.root;
}

/** The last read has been showing for a while now, and it follows from no move. */
function believe(tabId: string, s: Session, now: number) {
  const r = s.pending!;
  if (r.fen) {
    turnBoard(tabId, s, r.whiteAtBottom);
    jumpTo(tabId, s, r.fen);
    settle(tabId, s);
    return;
  }
  // no position in this picture: covered, or the board is somewhere else by now
  if (!s.lostSince) s.lostSince = now;
  if (now - s.lostSince < LOST_MS) return;
  if (tabOf(tabId)?.live?.status !== "lost-sync") patchLive(tabId, { status: "lost-sync" });
  if (!s.detecting && now - s.lastDetect > DETECT_MS) {
    s.lastDetect = now;
    void redetect(tabId).catch(() => null);
  }
}

function tick(tabId: string, s: Session) {
  if (!s.source.size()[0]) return;
  const [x, y, w, h] = s.box;
  const now = performance.now();
  const frame = s.source.frames?.() ?? 0;
  if (!s.prev || !s.source.frames || frame !== s.frame) {
    s.frame = frame;
    s.thumb.drawImage(s.source.image, x, y, w, h, 0, 0, THUMB, THUMB);
    const fresh = grey(s.thumb.getImageData(0, 0, THUMB, THUMB).data);
    if (s.prev && diff(fresh, s.prev) > CHANGED) {
      s.changedAt = now;
      s.changedFrame = frame;
    }
    s.prev = fresh;
  }
  const px = s.prev;
  if (s.busy) return;
  // the picture will not hold still (a mouse pointer over the board, say) but keeps showing this position
  if (s.pending?.fen && now - s.unknownSince >= HOLD_LONG_MS) return believe(tabId, s, now);
  if (!s.sent || diff(px, s.sent) > CHANGED || now - s.lastSent > REREAD_MS) {
    s.pending = undefined; // it was about another picture, or is about to be confirmed
    const size = Math.max(64, Math.min(512, Math.round(w)));
    if (s.crop.width !== size) s.crop.width = s.crop.height = size;
    s.crop.getContext("2d")!.drawImage(s.source.image, x, y, w, h, 0, 0, size, size);
    s.busy = true;
    s.sent = px;
    s.lastSent = now;
    read(tabId, s)
      .catch((e) => {
        s.failures++;
        console.warn("live capture:", e);
        if (s.failures === FAILS_SHOWN && sessions.get(tabId) === s)
          patchLive(tabId, { error: `Could not read the board: ${e?.message || e}` });
      })
      .finally(() => {
        s.busy = false;
        // a frame that came meanwhile, such as the end of the animation this one caught, does not wait for the next tick
        if (sessions.get(tabId) === s) tick(tabId, s);
      });
    return;
  }
  const still = now - s.changedAt;
  if (s.pending && (still >= HOLD_LONG_MS || (still >= HOLD_MS && (!s.source.frames || frame > s.changedFrame)))) believe(tabId, s, now);
}

/** Follow the board inside `box` of a shared screen in the given live tab. */
export function startCapture(tabId: string, source: FrameSource, box: Box, whiteAtBottom: boolean) {
  stopCapture(tabId);
  const thumbCanvas = document.createElement("canvas");
  thumbCanvas.width = thumbCanvas.height = THUMB;
  const s: Session = {
    source, box, whiteAtBottom, crop: document.createElement("canvas"),
    thumb: thumbCanvas.getContext("2d", { willReadFrequently: true })!, stopTicks: () => {},
    at: lastId(tabOf(tabId)!.game), prev: null, frame: 0, changedAt: 0, changedFrame: 0, sent: null, busy: false, lastSent: 0,
    unknownSince: 0, lostSince: 0, detecting: false, lastDetect: 0, failures: 0, games: [],
  };
  s.stopTicks = steadily(() => tick(tabId, s), TICK_MS);
  source.onFrame?.(() => tick(tabId, s));
  sessions.set(tabId, s);
  registerCapture(tabId, () => stopCapture(tabId));
  source.onEnded(() => {
    if (sessions.get(tabId) !== s) return;
    stopCapture(tabId);
    patchLive(tabId, { status: "stopped" });
  });
  patchLive(tabId, { status: "live", error: undefined });
}

export function stopCapture(tabId: string) {
  const s = sessions.get(tabId);
  if (!s) return;
  sessions.delete(tabId);
  unregisterCapture(tabId);
  s.stopTicks();
  s.source.stop();
}

/** The cropped board as last read, for a preview. */
export const captureCanvas = (tabId: string) => sessions.get(tabId)?.crop ?? null;

/** The node showing what is on screen. */
export const followedNode = (tabId: string) => sessions.get(tabId)?.at;

/** Find the board again (it moved or was resized on screen). Returns an error message or null. */
export async function redetect(tabId: string): Promise<string | null> {
  const s = sessions.get(tabId);
  if (!s) return "Not capturing";
  s.detecting = true;
  try {
    const r = await detectBoard(await grabFrame(s.source));
    if (!r.ok || !r.bbox) return r.error ?? "No board found";
    if (r.bbox.some((v, i) => Math.abs(v - s.box[i]) > 1)) {
      s.box = r.bbox;
      s.prev = s.sent = null;
    }
    return null;
  } finally {
    s.detecting = false;
  }
}

/** Start again a tab whose capture stopped (e.g. after a reload), from the given frames or else a new share of the screen. */
export async function resumeCapture(tabId: string, from?: FrameSource): Promise<string | null> {
  const t = useTabs.getState().tabs.find((x) => x.id === tabId);
  if (!t) {
    from?.stop();
    return null;
  }
  const source = from ?? (await shareScreen());
  const r = await detectBoard(await grabFrame(source)).catch((e) => ({ ok: false, error: String(e?.message || e), bbox: undefined }));
  if (!r.ok || !r.bbox) {
    source.stop();
    return r.error ?? "No board found on the shared screen";
  }
  startCapture(tabId, source, r.bbox, t.orientation === "white");
  return null;
}
