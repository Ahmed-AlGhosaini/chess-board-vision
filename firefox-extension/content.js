"use strict";
/*
 * Reads the board on a Lichess page whenever it changes and hands the position to background.js.
 *
 * Lichess's board is chessground: <piece class="white knight"> inside <cg-board>, square in
 * `cgKey` (a property the page sets, so behind wrappedJSObject here) or else the CSS transform.
 * Most pages do not say whose turn it is: that comes from the highlighted last move.
 */

const ROLES = { pawn: "p", knight: "n", bishop: "b", rook: "r", queen: "q", king: "k" };
// Small previews next to the real board: hover cards, game lists, the engine line under the mouse.
const PREVIEW = ".mini-game, .mini-board, .pv-board, #powerTip";
const width = (el) => el.getBoundingClientRect().width;

function findBoard() {
  return [...document.querySelectorAll("cg-board")]
    .filter((b) => !b.closest(PREVIEW))
    .sort((a, b) => width(b) - width(a))[0];
}

/** What is on the board, or null while it is half drawn. */
function readBoard(cg) {
  const grid = Array.from({ length: 8 }, () => Array(8).fill(null)); // [rank][file]
  const size = width(cg) / 8;
  const black = !!cg.closest(".orientation-black");

  const at = (el) => {
    const key = el.wrappedJSObject.cgKey;
    if (typeof key === "string" && /^[a-h][1-8]$/.test(key)) return [key.charCodeAt(0) - 97, +key[1] - 1];
    const m = /translate\(\s*(-?[\d.]+)px(?:\s*,\s*(-?[\d.]+)px)?/.exec(el.style.transform); // no y when it is 0
    if (!m || !size) return null;
    const c = Math.round(+m[1] / size), r = Math.round(+(m[2] ?? 0) / size);
    return black ? [7 - c, r] : [c, 7 - r];
  };

  for (const p of cg.querySelectorAll("piece")) {
    if (p.parentElement !== cg || p.classList.contains("ghost") || p.classList.contains("fading")) continue;
    const color = p.classList.contains("white") ? "w" : p.classList.contains("black") ? "b" : null;
    const role = Object.keys(ROLES).find((r) => p.classList.contains(r));
    const sq = at(p);
    if (color && role && sq && sq[0] >= 0 && sq[0] < 8 && sq[1] >= 0 && sq[1] < 8)
      grid[sq[1]][sq[0]] = color === "w" ? ROLES[role].toUpperCase() : ROLES[role];
  }
  const cells = grid.flat();
  if (cells.filter((p) => p === "K").length !== 1 || cells.filter((p) => p === "k").length !== 1) return null;

  const last = [...cg.querySelectorAll("square.last-move")].map(at).filter(Boolean);
  let turn = "w";
  for (const [f, r] of last) {
    const p = grid[r][f];
    if (p) turn = p === p.toUpperCase() ? "b" : "w";
  }
  let castling = "";
  if (grid[0][4] === "K") castling += (grid[0][7] === "R" ? "K" : "") + (grid[0][0] === "R" ? "Q" : "");
  if (grid[7][4] === "k") castling += (grid[7][7] === "r" ? "k" : "") + (grid[7][0] === "r" ? "q" : "");
  let ep = "-";
  if (last.length === 2 && last[0][0] === last[1][0]) {
    const f = last[0][0];
    const ranks = last.map((s) => s[1]).sort().join("");
    if (ranks === "13" && grid[3][f] === "P" && turn === "b") ep = "abcdefgh"[f] + "3";
    if (ranks === "46" && grid[4][f] === "p" && turn === "w") ep = "abcdefgh"[f] + "6";
  }
  const placement = grid.slice().reverse()
    .map((row) => row.map((p) => p ?? "1").join("").replace(/1+/g, (s) => String(s.length))).join("/");
  // Analysis boards and studies show the exact position in a text box, once it has caught up with the board.
  const exact = [...document.querySelectorAll("input.copyable")].map((i) => i.value)
    .find((v) => v.startsWith(placement + " w ") || v.startsWith(placement + " b "));
  return { fen: exact ?? `${placement} ${turn} ${castling || "-"} ${ep} 0 1`, orientation: black ? "black" : "white" };
}

/** The page's state as a message for background.js, or null to keep the last one (board half drawn). */
function readPage() {
  // The resign and draw buttons exist only for a player of a game in progress. Engine help
  // during your own game is against Lichess's rules, so such a board is held back until it ends.
  if (document.querySelector(".round__app .rcontrols .ricons")) return { type: "playing" };
  const cg = findBoard();
  if (!cg) return { type: "none" };
  const board = readBoard(cg);
  return board && { type: "board", board: { ...board, url: location.href } };
}

let enabled = false;
let sent = ""; // what background.js last heard
let candidate = "";
let timer = 0;

const keyOf = (m) => (m.board ? m.board.fen + m.board.orientation : m.type);

function report(msg) {
  sent = keyOf(msg);
  browser.runtime.sendMessage(msg).catch(() => {}); // the extension is being updated
}

/** A position must read the same twice in a row, as pieces are not all redrawn at once. A hidden
 * tab reads right away instead: nothing animates there, and waiting would miss moves. */
function check(settled = false) {
  timer = 0;
  if (!enabled) return;
  const now = readPage();
  if (!now) return;
  const key = keyOf(now);
  if (key === sent) {
    candidate = "";
  } else if (settled || key === candidate) {
    candidate = "";
    report(now);
  } else {
    candidate = key;
    schedule();
  }
}

// Timers in a hidden tab can lag by many seconds, messages do not.
const channel = new MessageChannel();
const queued = [];
channel.port1.onmessage = () => {
  for (const f of queued.splice(0)) {
    try {
      f();
    } catch (e) {
      console.error(e);
    }
  }
};
function soon(f) {
  queued.push(f);
  channel.port2.postMessage(0);
}

function schedule() {
  if (timer) return;
  if (document.hidden) {
    timer = -1;
    soon(() => check(true));
  } else {
    timer = setTimeout(check, 150);
  }
}

new MutationObserver(schedule).observe(document.documentElement, {
  subtree: true, childList: true, attributes: true, attributeFilter: ["class", "style"],
});

// Chessground redraws on animation frames, which hidden tabs never get, so without this a board in
// the background stands still. Frames in quick succession (an animation, or any other loop on the
// page) wait for a timer, so that nothing spins.
const page = window.wrappedJSObject;
const nativeFrame = page.requestAnimationFrame;
let lastFrame = 0;
exportFunction((cb) => {
  if (!enabled || !document.hidden) return nativeFrame.call(page, cb);
  const run = () => {
    lastFrame = performance.now();
    cb(lastFrame);
  };
  if (performance.now() - lastFrame < 100) return setTimeout(run, 50);
  soon(run);
  return 0;
}, page, { defineAs: "requestAnimationFrame" });

// A page leaving says so; coming back from the browser's back/forward cache, it reports again.
addEventListener("pagehide", () => {
  if (enabled) report({ type: "none" });
});
addEventListener("pageshow", (e) => {
  if (e.persisted) {
    sent = "";
    check(true);
  }
});

function setEnabled(on) {
  enabled = on;
  sent = "";
  if (on) check(true);
}

browser.storage.onChanged.addListener((changes) => {
  if (changes.enabled) setEnabled(changes.enabled.newValue);
});
browser.storage.local.get({ enabled: true }).then((s) => setEnabled(s.enabled));
