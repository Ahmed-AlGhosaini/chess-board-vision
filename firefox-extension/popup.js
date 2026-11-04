"use strict";

const enabled = document.getElementById("enabled");
const app = document.getElementById("app");
const status = document.getElementById("status");

async function refresh() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  const s = await browser.runtime.sendMessage({ type: "status", tabId: tab?.id });
  enabled.checked = s.enabled;
  if (document.activeElement !== app) app.value = s.app;
  status.textContent = !s.enabled ? "Off."
    : s.text ?? (/^https:\/\/lichess\.org\//.test(tab?.url ?? "") ? "No board on this page." : "Open a board on lichess.org.");
}

enabled.onchange = () => browser.storage.local.set({ enabled: enabled.checked }).then(refresh);

app.onchange = () => {
  let url = null;
  try {
    url = new URL(app.value.trim());
  } catch {
    // reported below
  }
  // the only hosts the extension has permission for
  const ok = url && url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname);
  app.classList.toggle("error", !ok);
  if (ok) browser.storage.local.set({ app: url.origin });
};

refresh();
setInterval(refresh, 1000);
