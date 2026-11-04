"use strict";

const lists = {
  lichess: { section: document.getElementById("lichess-tabs"), list: document.getElementById("lichess"), shown: "" },
  other: { section: document.getElementById("other-tabs"), list: document.getElementById("other"), shown: "" },
};
const none = document.getElementById("none");
const app = document.getElementById("app");

const HIDDEN = "It is in the background, where videos freeze and some pages stop redrawing: keep it visible, in its own window if need be.";
const isLichess = (t) => /^https:\/\/lichess\.org\//.test(t.url ?? "");

/** A page the extension can take a picture of, other than the app itself. */
function capturable(t, appAddress) {
  if (!/^https?:\/\//.test(t.url ?? "")) return false;
  const here = new URL(t.url), there = new URL(appAddress);
  return here.port !== there.port || !["127.0.0.1", "localhost"].includes(here.hostname);
}

const rows = new Map(); // tabId -> its row, kept between refreshes: a redraw would lose a click

function rowFor(tabId) {
  let r = rows.get(tabId);
  if (r) return r;
  r = { li: document.createElement("li"), check: document.createElement("input"), title: document.createElement("span"), status: document.createElement("span"), picture: false };
  r.check.type = "checkbox";
  r.check.onchange = () => browser.runtime.sendMessage({ type: "choose", tabId, on: r.check.checked, picture: r.picture }).then(refresh);
  r.title.className = "title";
  r.status.className = "status";
  const label = document.createElement("label");
  label.append(r.check, r.title, r.status);
  r.li.append(label);
  rows.set(tabId, r);
  return r;
}

function fill(group, tabs, current, chosen, picture) {
  const ids = tabs.map((t) => t.id).join();
  if (ids !== group.shown) {
    group.shown = ids;
    group.list.replaceChildren(...tabs.map((t) => rowFor(t.id).li));
  }
  group.section.hidden = !tabs.length;
  for (const t of tabs) {
    const r = rowFor(t.id);
    const c = chosen[t.id];
    r.picture = picture;
    r.check.checked = !!c;
    r.title.textContent = r.title.title = t.title || t.url;
    r.status.textContent = !c ? "" : c.text + (picture && !t.active ? " " + HIDDEN : "");
    r.li.classList.toggle("here", t.id === current?.id);
  }
}

async function refresh() {
  const [all, s] = await Promise.all([browser.tabs.query({}), browser.runtime.sendMessage({ type: "status" })]);
  const [current] = await browser.tabs.query({ active: true, currentWindow: true });
  all.sort((a, b) => (b.id === current?.id) - (a.id === current?.id));
  // What decides the group is how a chosen tab is being read, wherever it has gone since.
  // So a tab chosen on Lichess stays listed after it leaves, to be unticked.
  const picture = (t) => (s.chosen[t.id] ? s.chosen[t.id].picture : !isLichess(t));
  const lichess = all.filter((t) => !picture(t));
  const other = all.filter((t) => picture(t) && (s.chosen[t.id] || capturable(t, s.app)));
  fill(lists.lichess, lichess, current, s.chosen, false);
  fill(lists.other, other, current, s.chosen, true);
  none.hidden = lichess.length + other.length > 0;
  if (document.activeElement !== app) app.value = s.app;
}

app.onchange = () => {
  let url = null;
  try {
    url = new URL(app.value.trim());
  } catch {
    // reported below
  }
  // the app runs on this computer, and pictures of tabs must not go anywhere else
  const ok = url && url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname);
  app.classList.toggle("error", !ok);
  if (ok) browser.storage.local.set({ app: url.origin });
};

refresh();
setInterval(refresh, 1000);
