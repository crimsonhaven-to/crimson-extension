/*
 * crimson-extension — popup controller.
 *
 * The whole UI is one red button. It reads state from the service worker, lets
 * the user flip `enabled`, and shows live stats. All the actual work lives in
 * the SW; this is just the switch.
 *
 * Uses its own tag strings (the popup isn't a content script, so protocol.js
 * isn't injected here) — keep in sync with src/protocol.js.
 */
const KIND = {
  GET_STATE: "popup_get_state",
  SET_ENABLED: "popup_set_enabled",
  ADD_SITE: "popup_add_site",
  REMOVE_SITE: "popup_remove_site",
};

const els = {
  body: document.body,
  toggle: document.getElementById("toggle"),
  label: document.querySelector(".power__label"),
  status: document.getElementById("status"),
  fetches: document.getElementById("stat-fetches"),
  rules: document.getElementById("stat-rules"),
  version: document.getElementById("version"),
  site: document.getElementById("site"),
  siteAction: document.getElementById("site-action"),
  siteHint: document.getElementById("site-hint"),
};

// Show the running extension version, straight from the manifest so it always
// matches whatever the release pipeline shipped.
els.version.textContent = "v" + chrome.runtime.getManifest().version;

function send(kind, extra = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ kind, ...extra }, (resp) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(resp || { ok: false });
      }
    });
  });
}

function render(state) {
  const on = Boolean(state.enabled);
  els.body.classList.toggle("on", on);
  els.body.classList.add("ready");
  els.toggle.disabled = false;
  els.toggle.setAttribute("aria-pressed", String(on));
  els.label.textContent = on ? "Extension Active" : "Use Extension";
  els.status.textContent = on
    ? "Streaming locally — backend is off the path. 🩸"
    : "Off. Click to handle sources in your browser.";
  if (state.stats) {
    els.fetches.textContent = String(state.stats.fetches ?? 0);
    els.rules.textContent = String(state.stats.mediaRulesActive ?? 0);
  }
  renderSite(state);
}

// The active tab, resolved once when the popup opens (activeTab gives us its URL).
// { tabId, site, host, builtin } for an http(s) tab, or null when N/A.
let tabInfo = null;

// Mirror manifest.json content_scripts — these origins always have the bridge, so
// there's nothing to offer for them.
function isBuiltin(u) {
  if (u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1")) return true;
  if (u.protocol === "https:" && (u.hostname === "crimsonhaven.to" || u.hostname.endsWith(".crimsonhaven.to"))) return true;
  return false;
}

function loadTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs && tabs[0];
      if (!tab || !tab.url) return resolve(null);
      let u;
      try {
        u = new URL(tab.url);
      } catch (_) {
        return resolve(null);
      }
      if (u.protocol !== "http:" && u.protocol !== "https:") return resolve(null);
      // Portless origin: match patterns can't carry a port, so this is the key.
      resolve({ tabId: tab.id, site: `${u.protocol}//${u.hostname}`, host: u.hostname, builtin: isBuiltin(u) });
    });
  });
}

// Show the per-site control for http(s) tabs that aren't already a built-in match.
function renderSite(state) {
  if (!tabInfo || tabInfo.builtin) {
    els.site.hidden = true;
    return;
  }
  els.site.hidden = false;
  const on = Array.isArray(state.havens) && state.havens.includes(tabInfo.site);
  els.site.classList.toggle("is-on", on);
  els.siteAction.disabled = false;
  els.siteAction.textContent = on ? `Disable on ${tabInfo.host}` : `Enable on ${tabInfo.host}`;
  els.siteHint.textContent = on
    ? "The companion is bound to this site."
    : "Run the companion on your own Crimson Haven.";
}

els.siteAction.addEventListener("click", async () => {
  if (!tabInfo) return;
  const on = els.site.classList.contains("is-on");

  if (on) {
    els.siteAction.disabled = true;
    const resp = await send(KIND.REMOVE_SITE, { site: tabInfo.site });
    if (resp.ok) {
      try { chrome.tabs.reload(tabInfo.tabId); } catch (_) { /* tab gone */ }
      await refresh();
    } else {
      els.siteAction.disabled = false;
      els.siteHint.textContent = "Couldn't disable — try again.";
    }
    return;
  }

  // Enabling: request host permission FIRST, straight from this click. Like the
  // power button, chrome.permissions.request() needs the user gesture, so nothing
  // may be awaited before it. Already-granted (e.g. broad <all_urls>) resolves
  // true instantly with no prompt.
  let granted = false;
  try {
    granted = await chrome.permissions.request({ origins: [tabInfo.site + "/*"] });
  } catch (_) {
    granted = false;
  }
  if (!granted) {
    els.siteHint.textContent = "Permission needed to run here.";
    return;
  }
  els.siteAction.disabled = true;
  const resp = await send(KIND.ADD_SITE, { site: tabInfo.site });
  if (resp.ok) {
    try { chrome.tabs.reload(tabInfo.tabId); } catch (_) { /* tab gone */ }
    window.close(); // reopen shows the site as bound; the reloaded page has the bridge
  } else {
    els.siteAction.disabled = false;
    els.siteHint.textContent = "Couldn't enable — try again.";
  }
});

async function refresh() {
  const state = await send(KIND.GET_STATE);
  if (!state.ok) {
    els.status.textContent = "Couldn't reach the companion core.";
    return;
  }
  render(state);
}

const NEED_ACCESS_MSG = "Needs site access to work — grant it to switch on.";

els.toggle.addEventListener("click", async () => {
  const wantOn = !els.body.classList.contains("on");

  // Turning ON requires the broad host permission. Request it FIRST, straight
  // from this click: chrome.permissions.request() only works during a user
  // gesture, so we must not await anything before it (a message round-trip would
  // consume the gesture and Chrome would reject the prompt). If it's already
  // granted this resolves true instantly with no prompt.
  if (wantOn) {
    let granted = false;
    try {
      granted = await chrome.permissions.request({ origins: ["<all_urls>"] });
    } catch (_) {
      granted = false;
    }
    if (!granted) {
      els.status.textContent = NEED_ACCESS_MSG;
      return;
    }
  }

  els.toggle.disabled = true;
  const resp = await send(KIND.SET_ENABLED, { enabled: wantOn });
  if (resp.ok) {
    await refresh();
  } else {
    els.toggle.disabled = false;
    els.status.textContent =
      resp.error === "host permission not granted"
        ? NEED_ACCESS_MSG
        : "That didn't take — try again?";
  }
});

// Resolve the active tab first (so the per-site control paints on the first
// frame), then keep stats fresh while the popup is open.
(async () => {
  tabInfo = await loadTab();
  await refresh();
})();
const poll = setInterval(refresh, 1500);
window.addEventListener("unload", () => clearInterval(poll));
