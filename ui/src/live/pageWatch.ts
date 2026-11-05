import { boardFen, fenError, movesBetween } from "../chess/position";
import { addLine, knownNode, type GameState } from "../chess/tree";
import { findInGame } from "../components/ImportModal";
import { useTabs } from "../store/tabs";
import { appendMoves, evaluate, isWatching, lastId, patchLive, registerCapture, resetGame, stopWatch, unregisterCapture } from "./watch";

/*
 * A live tab that follows a board on a Lichess page, sent by the browser extension
 * (firefox-extension/, one session per Firefox tab). Every position that arrives moves
 * the tab to the same place: to where it already is in the tree when the page steps
 * through a game, otherwise onto the moves that lead there.
 */

export interface PagePush {
  session: string;
  seq: number;
  fen: string;
  orientation: "white" | "black";
  url: string;
  stop?: boolean;
}

interface Session {
  seq: number;
  shown?: string; // the position and orientation last applied
  seen: number; // Date.now() of the last message
  busy: boolean; // loading the game
  next?: PagePush; // what arrived meanwhile
  stopped: boolean; // Stop was pressed in the tab (or the tab closed)
  page?: string; // the address being followed, without the #move
}

const STALE_MS = 20_000; // the extension repeats a board every 5 seconds
const sessions = new Map<string, Session>();

const tabFor = (session: string) => useTabs.getState().tabs.find((t) => t.live?.session === session);

/** The position, with the side to move corrected if the guess from the highlighted last move
 * cannot be right. Null when no such position can be played (a board editor mid-edit). */
function playable(fen: string): string | null {
  if (!fenError(fen)) return fen;
  const flipped = fen.replace(/ [wb] /, (m) => (m === " w " ? " b " : " w "));
  return fenError(flipped) ? null : flipped;
}

/** Bring the tab to the position. False when it does not follow from the tab's game. */
function follow(tabId: string, fen: string): boolean {
  const { tabs, updateTab, updateGame } = useTabs.getState();
  const g = tabs.find((t) => t.id === tabId)?.game;
  if (!g) return true;
  if (boardFen(g.nodes[g.cursor].fen) === boardFen(fen)) return true;
  const known = knownNode(g, fen);
  if (known) {
    updateGame(tabId, (x) => ({ ...x, cursor: known }));
    return true;
  }
  const placement = boardFen(fen);
  const end = lastId(g);
  const fromCursor = movesBetween(g.nodes[g.cursor].fen, placement);
  if (fromCursor && g.cursor !== end) { // the page left the game's main line: a variation
    const game = addLine(g, fromCursor, g.cursor);
    updateTab(tabId, () => ({ game }));
    evaluate(tabId, [game.cursor]);
    return true;
  }
  const moves = fromCursor ?? movesBetween(g.nodes[end].fen, placement);
  if (!moves) return false;
  updateGame(tabId, (x) => ({ ...x, cursor: end }));
  appendMoves(tabId, moves.map((uci) => ({ uci })), false); // the page plays its own sound
  return true;
}

async function apply(session: string, s: Session, p: PagePush) {
  s.shown = p.fen + p.orientation;
  const tab = tabFor(session);
  if (tab) {
    if (!isWatching(tab.id)) registerPage(tab.id, s);
    if (tab.live?.status !== "live" || tab.live.error || tab.live.url !== p.url) patchLive(tab.id, { status: "live", error: undefined, url: p.url });
    useTabs.getState().updateTab(tab.id, (t) => (t.orientation === p.orientation ? {} : { orientation: p.orientation }));
    if (follow(tab.id, p.fen)) return;
    // a jump: moves were missed or a new game started. The page's game may know it by now.
    s.busy = true;
    const found = await findInGame(p.url, p.fen);
    if (!tabFor(session)) return;
    if (found) useTabs.getState().updateTab(tab.id, (t) => ({ game: found, title: titleOf(found, t.title) }));
    else {
      resetGame(tab.id, p.fen);
      useTabs.getState().updateTab(tab.id, () => ({ title: "Lichess board" }));
    }
    return;
  }
  s.busy = true;
  const found = await findInGame(p.url, p.fen);
  const id = useTabs.getState().openTab({
    type: "live", title: found ? titleOf(found, "Lichess board") : "Lichess board", analysisOn: true, orientation: p.orientation,
    ...(found ? { game: found } : {}), live: { source: "page", status: "live", url: p.url, session },
  });
  if (!found) resetGame(id, p.fen);
  registerPage(id, s);
}

const titleOf = (g: GameState, fallback: string) => {
  const { White: w, Black: b } = g.headers;
  return w && w !== "?" && b && b !== "?" ? `${w} – ${b}` : fallback;
};

function registerPage(tabId: string, s: Session) {
  registerCapture(tabId, () => {
    s.stopped = true;
  });
}

/** Handle one message from the extension. Heartbeats repeat the position and change nothing. */
export function onPagePush(p: PagePush) {
  let s = sessions.get(p.session);
  if (!s) sessions.set(p.session, (s = { seq: 0, seen: 0, busy: false, stopped: false }));
  if (p.seq <= s.seq) return; // requests can overtake each other
  s.seq = p.seq;
  s.seen = Date.now();
  const tab = tabFor(p.session);
  if (p.stop) {
    if (tab) stopWatch(tab.id);
    sessions.delete(p.session);
    return;
  }
  // Stop holds for this page only: a new game in the same Firefox tab is followed again
  const page = p.url.split("#")[0];
  if (s.stopped && page === s.page) return;
  s.stopped = false;
  s.page = page;
  const fen = playable(p.fen);
  if (!fen) return;
  const push = { ...p, fen };
  if (fen + p.orientation === s.shown && tab?.live?.status === "live") return;
  if (s.busy) {
    s.next = push;
    return;
  }
  run(p.session, s, push);
}

function run(session: string, s: Session, p: PagePush) {
  void apply(session, s, p).finally(() => {
    s.busy = false;
    const next = s.next;
    s.next = undefined;
    if (next && !s.stopped) run(session, s, next);
  });
}

/** Stop was pressed and the page is still there: follow it again from its next message. */
export function resumePage(tabId: string): boolean {
  const session = useTabs.getState().tabs.find((t) => t.id === tabId)?.live?.session;
  const s = session ? sessions.get(session) : undefined;
  if (!s) return false;
  s.stopped = false;
  s.shown = undefined;
  registerPage(tabId, s);
  patchLive(tabId, { status: "live", error: undefined });
  return true;
}

export const pageKnown = (session?: string) => !!session && sessions.has(session);

// the page was closed or navigated away: nothing says so except the silence
setInterval(() => {
  for (const [session, s] of sessions) {
    if (Date.now() - s.seen < STALE_MS) continue;
    const tab = tabFor(session);
    if (tab) {
      unregisterCapture(tab.id);
      if (tab.live?.status === "live") patchLive(tab.id, { status: "stopped", error: "The page stopped sending. To follow it again, open a board on Lichess in that Firefox tab, with the tab ticked under the extension's toolbar button." });
    }
    sessions.delete(session);
  }
}, 10_000);
