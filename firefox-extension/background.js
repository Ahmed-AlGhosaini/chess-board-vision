"use strict";
/*
 * Sends the app what is in the tabs chosen in the popup, and nothing from any other tab. A tab
 * stays chosen until it is unticked or closed; nothing is remembered across a browser restart.
 *
 * A Lichess tab is read directly by content.js, which hands the position over here. Any other tab
 * is sent as a picture (`picture` below), which the app reads as it does a shared screen.
 *
 * This runs here and not in the page because an extension may reach 127.0.0.1 whatever the page's
 * security policy says, without the browser's local network prompt, and because a background page's
 * timers are not throttled like a hidden tab's: the heartbeat keeps going, and delivers the position
 * once the app has been opened.
 */

const DEFAULTS = { app: "http://127.0.0.1:8765" };
const HEARTBEAT_MS = 5000;
const FRAME_MS = 500;
const RUN = Date.now().toString(36); // tab ids repeat after a restart: an old capture is not resumed by a new tab

let settings = { ...DEFAULTS };
// The chosen tabs: tabId -> { state, picture, board?, image?, sentAt, sending? }, state is one of the STATES below
const tabs = new Map();
let seq = 0;

const STATES = {
  waiting: { badge: "…", color: "#868e96", text: "Waiting for a board on Lichess in this tab." },
  live: { badge: "●", color: "#2b8a3e", text: "Sending this board to chessvision." },
  picture: { badge: "●", color: "#2b8a3e", text: "Sending a picture of this tab to chessvision." },
  "no-picture": { badge: "!", color: "#e67700", text: "Cannot take a picture of this tab right now." },
  "no-ui": { badge: "!", color: "#e67700", text: "chessvision is running, but not open in a tab. Open it to see this board." },
  "no-app": { badge: "!", color: "#c92a2a", text: "Cannot reach chessvision. Start it with: python app.py (restart it if it was running before the extension was added)." },
  playing: { badge: "II", color: "#868e96", text: "Paused: you are playing this game. The board is sent again when the game ends." },
};

function show(tabId) {
  const state = STATES[tabs.get(tabId)?.state];
  browser.browserAction.setBadgeText({ tabId, text: state?.badge ?? "" }).catch(() => {}); // the tab may be gone
  if (state) browser.browserAction.setBadgeBackgroundColor({ tabId, color: state.color }).catch(() => {});
}

function setState(tabId, state) {
  const t = tabs.get(tabId);
  if (!t) return;
  t.state = state;
  show(tabId); // even if unchanged: navigating clears a tab's badge
}

/** Send a message to the app, which drops anything older than what it has by `seq`, which survives a browser restart. */
async function post(path, body) {
  seq = Math.max(seq + 1, Date.now());
  try {
    const r = await fetch(`${settings.app}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seq, ...body }),
    });
    return r.ok ? "live" : r.status === 503 ? "no-ui" : "no-app";
  } catch {
    return "no-app";
  }
}

async function send(tabId, board, stop = false) {
  const state = await post("/push/live", { session: `t${tabId}`, ...board, stop });
  if (!stop && tabs.get(tabId)?.board === board) setState(tabId, state);
}

const frameSession = (tabId) => `p${RUN}${tabId}`;

/** Take a picture of the tab and send it, if it changed or the app has not heard for a while. */
async function sendFrame(tabId, t) {
  try {
    const tab = await browser.tabs.get(tabId);
    const image = await browser.tabs.captureTab(tabId, { format: "jpeg", quality: 85 });
    if (tabs.get(tabId) !== t || (image === t.image && Date.now() - t.sentAt < HEARTBEAT_MS)) return;
    const state = await post("/push/frame", { session: frameSession(tabId), image, title: tab.title ?? "", url: tab.url ?? "" });
    t.image = image;
    t.sentAt = Date.now();
    if (tabs.get(tabId) === t) setState(tabId, state === "live" ? "picture" : state);
  } catch {
    if (tabs.get(tabId) === t) setState(tabId, "no-picture"); // discarded, or closing
  }
}

/** Stop following a tab, and tell the app at once. */
function drop(tabId) {
  const t = tabs.get(tabId);
  if (!t) return;
  tabs.delete(tabId);
  if (t.picture) (t.sending ?? Promise.resolve()).then(() => post("/push/frame", { session: frameSession(tabId), stop: true })); // after any frame on its way
  else if (t.board) send(tabId, t.board, true);
  show(tabId);
}

function choose(tabId, on, picture) {
  if (on === tabs.has(tabId)) return;
  const reads = !(on ? picture : tabs.get(tabId).picture);
  if (on) {
    tabs.set(tabId, { state: "waiting", picture, sentAt: 0 });
    show(tabId);
  } else {
    drop(tabId);
  }
  if (reads) browser.tabs.sendMessage(tabId, { type: "chosen", on }).catch(() => {}); // a page still loading asks by itself
}

browser.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type === "status") {
    const chosen = {}; // tabId -> what to say about it
    for (const [tabId, t] of tabs) chosen[tabId] = { text: STATES[t.state].text, picture: t.picture };
    return Promise.resolve({ app: settings.app, chosen });
  }
  if (msg.type === "choose") return void choose(msg.tabId, msg.on, msg.picture);
  const tabId = sender.tab?.id;
  const t = tabs.get(tabId);
  if (msg.type === "chosen?") return Promise.resolve(t?.picture === false);
  if (!t || t.picture) return; // unticked while this message was on its way
  if (msg.type === "board") {
    t.board = msg.board;
    send(tabId, msg.board);
  } else if (msg.type === "playing") {
    if (t.board) send(tabId, t.board, true);
    t.board = undefined;
    setState(tabId, "playing");
  } else if (msg.type === "none") {
    t.board = undefined; // the app notices the silence
    setState(tabId, "waiting");
  }
});

browser.tabs.onRemoved.addListener(drop);

setInterval(() => {
  for (const [tabId, t] of tabs) if (t.board) send(tabId, t.board);
}, HEARTBEAT_MS);

setInterval(() => {
  for (const [tabId, t] of tabs) {
    if (!t.picture || t.sending) continue;
    t.sending = sendFrame(tabId, t).finally(() => {
      t.sending = undefined;
    });
  }
}, FRAME_MS);

browser.storage.onChanged.addListener((changes) => {
  if (changes.app) settings.app = changes.app.newValue;
});

browser.storage.local.get(DEFAULTS).then((stored) => {
  settings = stored;
});
