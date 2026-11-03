import { gameOutcome } from "../chess/position";
import { api } from "../lib/api";
import { useTabs } from "../store/tabs";
import { appendMoves, lastId, patchLive, registerCapture, unregisterCapture } from "./watch";

/*
 * Screen capture as a live-game source: frames of a shared window or tab are
 * cropped to the board, and whenever the board has changed and then settled,
 * the crop goes to the server, which reads it and finds the legal moves that
 * lead from the game's last position to what is on screen.
 */

export type Box = [number, number, number, number]; // x, y, w, h in video pixels

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
  fen?: string;
  placement: string;
  uncertain: string[];
}

const TICK_MS = 400;
const THUMB = 32; // the board is compared between ticks as a 32x32 grey thumbnail (4x4 px per square)
// A move changes only 2-4 of the 64 squares, so changes are measured per square:
// a moved piece shifts its square's mean grey level by 25-40, video noise by 1-2.
const CHANGED = 10;
const FAILS_SHOWN = 3; // failed reads in a row before the error is shown in the tab
const RETRY_MS = 1500; // an unreadable frame is tried again after this long
const LOST_AFTER = 3; // unreadable reads in a row before the tab reports "lost track"

interface Session {
  stream: MediaStream;
  video: HTMLVideoElement;
  box: Box;
  whiteAtBottom: boolean;
  crop: HTMLCanvasElement;
  thumb: CanvasRenderingContext2D;
  timer: number;
  prev: Uint8ClampedArray | null; // thumbnail at the last tick
  sent: Uint8ClampedArray | null; // thumbnail last sent to the server
  busy: boolean;
  lastSent: number;
  lastStatus: string;
  unknown: number;
  failures: number; // reads in a row that failed (server error, network)
  placement?: string; // the last board that could not be matched, for "resync"
}

const sessions = new Map<string, Session>();

export const captureSupported = () => !!navigator.mediaDevices?.getDisplayMedia;

export function shareScreen(): Promise<MediaStream> {
  return navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 5, max: 10 } }, audio: false });
}

/** A playing, detached <video> for a stream, once its first frame is available. */
export async function videoFor(stream: MediaStream): Promise<HTMLVideoElement> {
  const v = document.createElement("video");
  v.muted = true;
  v.playsInline = true;
  v.srcObject = stream;
  await v.play();
  if (v.readyState < 2 || !v.videoWidth) await new Promise((r) => v.addEventListener("loadeddata", r, { once: true }));
  return v;
}

/** The whole current frame as a PNG. */
export function grabFrame(video: HTMLVideoElement): Promise<Blob> {
  const c = document.createElement("canvas");
  c.width = video.videoWidth;
  c.height = video.videoHeight;
  c.getContext("2d")!.drawImage(video, 0, 0);
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

const lastFen = (tabId: string) => {
  const t = useTabs.getState().tabs.find((x) => x.id === tabId);
  return t ? t.game.nodes[lastId(t.game)].fen : null;
};

async function read(tabId: string, s: Session) {
  const fen = lastFen(tabId);
  if (!fen) return;
  const blob = await new Promise<Blob | null>((r) => s.crop.toBlob(r, "image/jpeg", 0.92));
  if (!blob) return;
  const q = new URLSearchParams({ fen, orientation: s.whiteAtBottom ? "white" : "black" });
  const r = await api<TrackResult>(`/api/vision/track?${q}`, { method: "POST", body: blob, headers: { "Content-Type": "application/octet-stream" } });
  if (sessions.get(tabId) !== s) return; // stopped meanwhile
  if (s.failures >= FAILS_SHOWN) patchLive(tabId, { error: undefined });
  s.failures = 0;
  if (lastFen(tabId) !== fen) {
    s.sent = null; // the game changed while this frame was read (e.g. a resync): read again
    return;
  }
  s.lastStatus = r.status;
  if (r.status === "unknown") {
    s.unknown++;
    s.placement = r.placement;
    if (s.unknown === LOST_AFTER) patchLive(tabId, { status: "lost-sync" });
    return;
  }
  const live = useTabs.getState().tabs.find((x) => x.id === tabId)?.live;
  if (s.unknown >= LOST_AFTER && live?.status === "lost-sync") patchLive(tabId, { status: "live" });
  s.unknown = 0;
  if (r.status === "moves") {
    appendMoves(tabId, r.moves.map((uci) => ({ uci })));
    const over = r.fen ? gameOutcome(r.fen) : null;
    if (over) {
      useTabs.getState().updateTab(tabId, (t) => ({ game: { ...t.game, headers: { ...t.game.headers, Result: over.result } } }));
      patchLive(tabId, { status: "ended", reason: over.reason });
    }
  }
}

function tick(tabId: string, s: Session) {
  if (s.busy || s.video.readyState < 2) return;
  const [x, y, w, h] = s.box;
  const size = Math.max(64, Math.min(512, Math.round(w)));
  if (s.crop.width !== size) s.crop.width = s.crop.height = size;
  s.crop.getContext("2d")!.drawImage(s.video, x, y, w, h, 0, 0, size, size);
  s.thumb.drawImage(s.crop, 0, 0, THUMB, THUMB);
  const px = grey(s.thumb.getImageData(0, 0, THUMB, THUMB).data);
  const moving = s.prev !== null && diff(px, s.prev) > CHANGED;
  s.prev = px;
  if (moving) return; // wait until the board has settled (piece animations, drags)
  const fresh = !s.sent || diff(px, s.sent) > CHANGED;
  const retry = s.lastStatus === "unknown" && performance.now() - s.lastSent > RETRY_MS;
  if (!fresh && !retry) return;
  s.busy = true;
  s.sent = px;
  s.lastSent = performance.now();
  read(tabId, s)
    .catch((e) => {
      s.lastStatus = "unknown"; // try this frame again shortly
      s.failures++;
      console.warn("live capture:", e);
      if (s.failures === FAILS_SHOWN && sessions.get(tabId) === s)
        patchLive(tabId, { error: `Could not read the board: ${e?.message || e}` });
    })
    .finally(() => {
      s.busy = false;
    });
}

/** Follow the board inside `box` of a shared screen in the given live tab. */
export function startCapture(tabId: string, stream: MediaStream, video: HTMLVideoElement, box: Box, whiteAtBottom: boolean) {
  stopCapture(tabId);
  const thumbCanvas = document.createElement("canvas");
  thumbCanvas.width = thumbCanvas.height = THUMB;
  const s: Session = {
    stream, video, box, whiteAtBottom, crop: document.createElement("canvas"),
    thumb: thumbCanvas.getContext("2d", { willReadFrequently: true })!, timer: 0,
    prev: null, sent: null, busy: false, lastSent: 0, lastStatus: "", unknown: 0, failures: 0,
  };
  s.timer = window.setInterval(() => tick(tabId, s), TICK_MS);
  sessions.set(tabId, s);
  registerCapture(tabId, () => stopCapture(tabId));
  stream.getVideoTracks()[0]?.addEventListener("ended", () => {
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
  clearInterval(s.timer);
  s.stream.getTracks().forEach((t) => t.stop());
}

/** The cropped board as last captured, for a preview. */
export const captureCanvas = (tabId: string) => sessions.get(tabId)?.crop ?? null;

/** The last board on screen that did not follow from the game (offered as a new start). */
export const unmatchedPlacement = (tabId: string) => sessions.get(tabId)?.placement;

/** Find the board again (it moved or was resized on screen). Returns an error message or null. */
export async function redetect(tabId: string): Promise<string | null> {
  const s = sessions.get(tabId);
  if (!s) return "Not capturing";
  const r = await detectBoard(await grabFrame(s.video));
  if (!r.ok || !r.bbox) return r.error ?? "No board found";
  s.box = r.bbox;
  s.prev = s.sent = null;
  return null;
}

/** Share the screen again for a tab whose capture stopped (e.g. after a reload). */
export async function resumeCapture(tabId: string): Promise<string | null> {
  const t = useTabs.getState().tabs.find((x) => x.id === tabId);
  if (!t) return null;
  const stream = await shareScreen();
  const video = await videoFor(stream);
  const r = await detectBoard(await grabFrame(video));
  if (!r.ok || !r.bbox) {
    stream.getTracks().forEach((x) => x.stop());
    return r.error ?? "No board found on the shared screen";
  }
  startCapture(tabId, stream, video, r.bbox, t.orientation === "white");
  return null;
}
