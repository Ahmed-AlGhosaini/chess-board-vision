"use strict";
/*
 * Passes the boards content.js reads on to the app. This runs here and not in the page because
 * an extension may reach 127.0.0.1 whatever the page's security policy says, without the browser's
 * local network prompt, and because a background page's timers are not throttled like a hidden
 * tab's: the heartbeat keeps going, and delivers the position once the app has been opened.
 */

const DEFAULTS = { enabled: true, app: "http://127.0.0.1:8765" };
const HEARTBEAT_MS = 5000;

let settings = { ...DEFAULTS };
const tabs = new Map(); // tabId -> { state, board? }: state is one of the STATES below
let seq = 0;

const STATES = {
  live: { badge: "●", color: "#2b8a3e", text: "Sending this board to chessvision." },
  "no-ui": { badge: "!", color: "#e67700", text: "chessvision is running, but not open in a tab. Open it to see this board." },
  "no-app": { badge: "!", color: "#c92a2a", text: "Cannot reach chessvision. Start it with: python app.py (restart it if it was running before the extension was added)." },
  playing: { badge: "II", color: "#868e96", text: "Paused: you are playing this game. The board is sent again when the game ends." },
};

function show(tabId) {
  const state = settings.enabled ? STATES[tabs.get(tabId)?.state] : undefined;
  browser.browserAction.setBadgeText({ tabId, text: state?.badge ?? "" }).catch(() => {}); // the tab may be gone
  if (state) browser.browserAction.setBadgeBackgroundColor({ tabId, color: state.color }).catch(() => {});
}

function setState(tabId, state) {
  const t = tabs.get(tabId);
  if (!t) return;
  t.state = state;
  show(tabId); // even if unchanged: navigating clears a tab's badge
}

/** Send a board. The app drops anything older than what it has by `seq`, which survives a browser restart. */
async function send(tabId, board, stop = false) {
  seq = Math.max(seq + 1, Date.now());
  let state;
  try {
    const r = await fetch(`${settings.app}/push/live`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: `t${tabId}`, seq, ...board, stop }),
    });
    state = r.ok ? "live" : r.status === 503 ? "no-ui" : "no-app";
  } catch {
    state = "no-app";
  }
  if (!stop && tabs.get(tabId)?.board === board) setState(tabId, state);
}

/** The tab has no board any more: tell the app at once if `stop`, else it notices the silence. */
function forget(tabId, stop) {
  const board = tabs.get(tabId)?.board;
  tabs.delete(tabId);
  if (stop && board) send(tabId, board, true);
  show(tabId);
}

browser.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type === "status") {
    return Promise.resolve({ ...settings, text: STATES[tabs.get(msg.tabId)?.state]?.text });
  }
  const tabId = sender.tab?.id;
  if (tabId === undefined || !settings.enabled) return;
  if (msg.type === "board") {
    const t = tabs.get(tabId) ?? { state: undefined };
    t.board = msg.board;
    tabs.set(tabId, t);
    send(tabId, msg.board);
  } else if (msg.type === "playing") {
    forget(tabId, true);
    tabs.set(tabId, { state: "playing" });
    show(tabId);
  } else if (msg.type === "none") {
    forget(tabId, false);
  }
});

browser.tabs.onRemoved.addListener((tabId) => forget(tabId, true));

setInterval(() => {
  if (!settings.enabled) return;
  for (const [tabId, t] of tabs) if (t.board) send(tabId, t.board);
}, HEARTBEAT_MS);

browser.storage.onChanged.addListener((changes) => {
  if (changes.app) settings.app = changes.app.newValue;
  if (changes.enabled) {
    settings.enabled = changes.enabled.newValue;
    // when turned on, the pages report their boards again
    if (!settings.enabled) for (const tabId of [...tabs.keys()]) forget(tabId, true);
  }
});

browser.storage.local.get(DEFAULTS).then((stored) => {
  settings = stored;
});
