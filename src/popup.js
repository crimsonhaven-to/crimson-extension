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
};

const els = {
  body: document.body,
  toggle: document.getElementById("toggle"),
  label: document.querySelector(".power__label"),
  status: document.getElementById("status"),
  fetches: document.getElementById("stat-fetches"),
  rules: document.getElementById("stat-rules"),
};

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
}

async function refresh() {
  const state = await send(KIND.GET_STATE);
  if (!state.ok) {
    els.status.textContent = "Couldn't reach the companion core.";
    return;
  }
  render(state);
}

els.toggle.addEventListener("click", async () => {
  const wantOn = !els.body.classList.contains("on");
  els.toggle.disabled = true;
  const resp = await send(KIND.SET_ENABLED, { enabled: wantOn });
  if (resp.ok) {
    await refresh();
  } else {
    els.toggle.disabled = false;
    els.status.textContent = "That didn't take — try again?";
  }
});

// Keep stats fresh while the popup is open.
refresh();
const poll = setInterval(refresh, 1500);
window.addEventListener("unload", () => clearInterval(poll));
