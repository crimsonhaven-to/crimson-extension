/*
 * crimson-extension — service worker (the privileged core).
 *
 * Two capabilities, and ONLY these two — this companion does CORS unblock +
 * header injection, nothing else (no scraping logic lives here; that's
 * crimson-sources' job in the page):
 *
 *   1. FETCH       — a cross-origin fetch RPC. The page asks us to fetch a URL
 *                    with a given header set (incl. forbidden ones like Referer/
 *                    Origin/User-Agent that a page's own fetch() can't set), and
 *                    we hand back the body. We can READ the response because the
 *                    extension has host access, so there's no CORS wall; we
 *                    inject the forbidden headers with an ephemeral DNR rule
 *                    scoped to this SW request (tabIds:[-1]).
 *
 *   2. MEDIA_RULES — declarative header + CORS rules for the *page's own* media
 *                    fetches (hls.js / <video>). Scoped to the calling tab, they
 *                    inject the per-stream Referer/Origin/UA the CDN gates on and
 *                    add `Access-Control-Allow-Origin: *` to the response, so the
 *                    player streams segments straight from the CDN — bytes never
 *                    touch the backend or the cors-proxy.
 *
 * Everything is gated behind the user-controlled `enabled` flag (the popup's one
 * red button). Disabled => we answer handshakes but refuse all work.
 */
importScripts("protocol.js");

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let enabled = false;
const stats = { fetches: 0, mediaRulesActive: 0 };

// Media rules currently installed, grouped by the tab that owns them, so we can
// tear them down when that tab navigates away or closes.
//   tabId -> Set<ruleId>
const mediaRulesByTab = new Map();

// Rolling allocators for the two disjoint id ranges (see protocol.js).
let fetchRuleSeq = CRX.FETCH_RULE_MIN;
let mediaRuleSeq = CRX.MEDIA_RULE_MIN;

function nextFetchRuleId() {
  fetchRuleSeq += 1;
  if (fetchRuleSeq > CRX.FETCH_RULE_MAX) fetchRuleSeq = CRX.FETCH_RULE_MIN;
  return fetchRuleSeq;
}

function nextMediaRuleId() {
  mediaRuleSeq += 1;
  if (mediaRuleSeq > CRX.MEDIA_RULE_MAX) mediaRuleSeq = CRX.MEDIA_RULE_MIN;
  return mediaRuleSeq;
}

// ---------------------------------------------------------------------------
// Startup / persistence
// ---------------------------------------------------------------------------

async function loadState() {
  const got = await chrome.storage.local.get([CRX.STORE_ENABLED]);
  enabled = Boolean(got[CRX.STORE_ENABLED]);
  // Session DNR rules survive a SW restart, but our in-memory id counters and the
  // tab->rules map do NOT. Reconcile so we (a) never hand out an id that's still
  // live (which would throw on add), and (b) drop orphaned rules from a previous SW
  // life when we're disabled, so nothing keeps touching traffic.
  try {
    const existing = await chrome.declarativeNetRequest.getSessionRules();
    if (!enabled && existing.length) {
      await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: existing.map((r) => r.id),
      });
    } else {
      for (const r of existing) {
        if (r.id >= CRX.FETCH_RULE_MIN && r.id <= CRX.FETCH_RULE_MAX) {
          fetchRuleSeq = Math.max(fetchRuleSeq, r.id);
        } else if (r.id >= CRX.MEDIA_RULE_MIN && r.id <= CRX.MEDIA_RULE_MAX) {
          mediaRuleSeq = Math.max(mediaRuleSeq, r.id);
        }
      }
    }
  } catch (_) {
    /* reconciliation is best-effort; idempotent adds (below) cover the rest. */
  }
  await refreshActionUI();
}

// The SW is ephemeral (MV3 kills it after ~30s idle) and can be spun up cold by
// any event — including a page's very first FETCH/HELLO. `loadState` is async, so
// until it resolves `enabled` still holds its default `false`; a privileged
// message answered in that window would wrongly report "disabled" even though the
// user enabled it (a prime cause of the companion "sometimes" working). We expose
// a `readyPromise` the message handler awaits before reading `enabled`, so every
// answer reflects persisted storage, not the cold-start default.
let readyPromise = loadState();
chrome.runtime.onInstalled.addListener(() => {
  readyPromise = loadState();
});
chrome.runtime.onStartup.addListener(() => {
  readyPromise = loadState();
});

async function setEnabled(next) {
  enabled = Boolean(next);
  await chrome.storage.local.set({ [CRX.STORE_ENABLED]: enabled });
  if (!enabled) {
    // Going dark: rip out every rule we own so we stop touching traffic.
    await clearAllRules();
  }
  await refreshActionUI();
  broadcastState();
}

// ---------------------------------------------------------------------------
// Toolbar UI (icon + badge reflect on/off at a glance)
// ---------------------------------------------------------------------------

async function refreshActionUI() {
  const suffix = enabled ? "" : "-off";
  try {
    await chrome.action.setIcon({
      path: {
        16: `icons/icon-16${suffix}.png`,
        32: `icons/icon-32${suffix}.png`,
        48: `icons/icon-48${suffix}.png`,
        128: `icons/icon-128${suffix}.png`,
      },
    });
  } catch (_) {
    /* setIcon can throw if the SW is mid-teardown; harmless. */
  }
  await chrome.action.setBadgeText({ text: enabled ? "ON" : "" });
  await chrome.action.setBadgeBackgroundColor({ color: "#c7042d" });
  await chrome.action.setTitle({
    title: enabled
      ? "Crimson Haven Companion — active 🦇"
      : "Crimson Haven Companion — click to enable",
  });
}

// ---------------------------------------------------------------------------
// DNR helpers
// ---------------------------------------------------------------------------

// Turn a {Header-Name: value} map into DNR modifyHeaders entries. A null/empty
// value means "remove this header" instead of setting it.
function toHeaderOps(map) {
  const ops = [];
  for (const [name, value] of Object.entries(map || {})) {
    if (value === null || value === undefined || value === "") {
      ops.push({ header: name, operation: "remove" });
    } else {
      ops.push({ header: name, operation: "set", value: String(value) });
    }
  }
  return ops;
}

// urlFilter has reserved chars (* ^ |). If the URL contains any, fall back to a
// safe prefix so the rule still matches (it's scoped to one SW request anyway).
function safeUrlFilter(url) {
  const reserved = /[\^|*]/;
  if (!reserved.test(url)) return url;
  const cut = url.search(reserved);
  return url.slice(0, cut) || url.split("?")[0];
}

async function addSessionRules(rules) {
  // Idempotent add: remove any rule already holding these ids first. Session rules
  // persist across SW restarts while our id counters reset, so a reused id would
  // otherwise throw "rule with id N already exists" and silently drop the header
  // injection (→ CDN 403). Removing-then-adding the same ids in one call is atomic.
  const ids = rules.map((r) => r.id);
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ids, addRules: rules });
}

async function removeSessionRules(ids) {
  if (!ids || !ids.length) return;
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ids });
}

async function clearAllRules() {
  const existing = await chrome.declarativeNetRequest.getSessionRules();
  if (existing.length) {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: existing.map((r) => r.id),
    });
  }
  mediaRulesByTab.clear();
  stats.mediaRulesActive = 0;
}

// ---------------------------------------------------------------------------
// Capability 1: privileged fetch with header injection
// ---------------------------------------------------------------------------

async function doFetch(payload) {
  const {
    url,
    method = "GET",
    headers = {},
    body = null,
    redirect = "follow",
    credentials = "omit",
    responseType = "text", // "text" | "arraybuffer"
  } = payload || {};

  if (!url || typeof url !== "string") {
    return { ok: false, error: "missing url" };
  }

  const headerOps = toHeaderOps(headers);
  const ruleId = nextFetchRuleId();
  let ruleAdded = false;

  // Inject the (often forbidden) headers via an ephemeral DNR rule scoped to
  // requests that aren't tied to a tab — i.e. exactly this SW-initiated fetch
  // (tabIds:[-1]) — so it can never bleed into the page's own media traffic.
  if (headerOps.length) {
    // Match by host (requestDomains), not the full URL. A `urlFilter` of the whole
    // URL is a tokenised pattern, not a literal — reserved chars (* ^ |) and query
    // strings make it silently fail to match, so the headers don't get injected and
    // the gated CDN 403s. Host-scoping + tabIds:[-1] reliably targets this SW fetch.
    const host = (() => {
      try {
        return new URL(url).hostname;
      } catch (_) {
        return null;
      }
    })();
    const condition = {
      resourceTypes: ["xmlhttprequest", "other", "media"],
      tabIds: [-1],
    };
    if (host) condition.requestDomains = [host];
    else condition.urlFilter = safeUrlFilter(url);

    await addSessionRules([
      {
        id: ruleId,
        priority: 1,
        action: { type: "modifyHeaders", requestHeaders: headerOps },
        condition,
      },
    ]);
    ruleAdded = true;
  }

  try {
    const init = { method, redirect, credentials };
    if (body !== null && body !== undefined && method !== "GET" && method !== "HEAD") {
      init.body = body;
    }
    const res = await fetch(url, init);

    const outHeaders = {};
    for (const [k, v] of res.headers.entries()) outHeaders[k] = v;

    let outBody;
    let bodyEncoding;
    if (responseType === "arraybuffer") {
      const buf = await res.arrayBuffer();
      outBody = arrayBufferToBase64(buf);
      bodyEncoding = "base64";
    } else {
      outBody = await res.text();
      bodyEncoding = "text";
    }

    stats.fetches += 1;
    return {
      ok: true,
      status: res.status,
      statusText: res.statusText,
      url: res.url,
      redirected: res.redirected,
      headers: outHeaders,
      body: outBody,
      bodyEncoding,
    };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  } finally {
    if (ruleAdded) {
      try {
        await removeSessionRules([ruleId]);
      } catch (_) {
        /* best effort */
      }
    }
  }
}

function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// ---------------------------------------------------------------------------
// Capability 2: declarative media unblock (header injection + CORS) for the
// page's own hls.js / <video> fetches, scoped to the calling tab.
// ---------------------------------------------------------------------------

// CORS response headers we add so the page can READ cross-origin media.
function corsResponseOps() {
  return [
    { header: "access-control-allow-origin", operation: "set", value: "*" },
    { header: "access-control-allow-methods", operation: "set", value: "GET,HEAD,OPTIONS" },
    { header: "access-control-allow-headers", operation: "set", value: "*" },
    { header: "access-control-expose-headers", operation: "set", value: "*" },
  ];
}

async function installMediaRules(payload, tabId) {
  if (tabId === undefined || tabId === null || tabId < 0) {
    return { ok: false, error: "no tab context" };
  }
  const spec = payload || {};
  const rules = Array.isArray(spec.rules) ? spec.rules : [];

  // `replace` (default true) clears this tab's existing media rules first, so a
  // source switch doesn't accumulate stale header profiles.
  if (spec.replace !== false) {
    await clearTabMediaRules(tabId);
  }

  const added = [];
  const dnrRules = [];
  for (const r of rules) {
    const id = nextMediaRuleId();
    const requestHeaders = toHeaderOps(r.requestHeaders || {});
    const responseHeaders = r.cors === false ? [] : corsResponseOps();
    const action = { type: "modifyHeaders" };
    if (requestHeaders.length) action.requestHeaders = requestHeaders;
    if (responseHeaders.length) action.responseHeaders = responseHeaders;
    if (!action.requestHeaders && !action.responseHeaders) continue;

    const condition = {
      resourceTypes: r.resourceTypes || [
        "media",
        "xmlhttprequest",
        "sub_frame",
        "image",
        "other",
      ],
      tabIds: [tabId],
    };
    // Target by host list (preferred — robust) or a urlFilter substring.
    if (Array.isArray(r.requestDomains) && r.requestDomains.length) {
      condition.requestDomains = r.requestDomains;
    } else if (r.urlFilter) {
      condition.urlFilter = r.urlFilter;
    } else {
      // No target => skip; we won't install a tab-wide header rewrite blindly.
      continue;
    }

    dnrRules.push({ id, priority: 1, action, condition });
    added.push(id);
  }

  if (dnrRules.length) {
    await addSessionRules(dnrRules);
    let set = mediaRulesByTab.get(tabId);
    if (!set) {
      set = new Set();
      mediaRulesByTab.set(tabId, set);
    }
    added.forEach((id) => set.add(id));
    recountMediaRules();
  }

  return { ok: true, ruleIds: added };
}

async function clearTabMediaRules(tabId) {
  const set = mediaRulesByTab.get(tabId);
  if (set && set.size) {
    await removeSessionRules([...set]);
    mediaRulesByTab.delete(tabId);
    recountMediaRules();
  }
}

async function clearRules(payload, tabId) {
  const ids = payload && Array.isArray(payload.ruleIds) ? payload.ruleIds : null;
  if (ids) {
    await removeSessionRules(ids);
    const set = mediaRulesByTab.get(tabId);
    if (set) ids.forEach((id) => set.delete(id));
  } else {
    await clearTabMediaRules(tabId);
  }
  recountMediaRules();
  return { ok: true };
}

function recountMediaRules() {
  let n = 0;
  for (const set of mediaRulesByTab.values()) n += set.size;
  stats.mediaRulesActive = n;
}

// Tear down a tab's rules when it navigates or closes so nothing leaks.
chrome.tabs.onRemoved.addListener((tabId) => {
  clearTabMediaRules(tabId);
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // A fresh top-level load invalidates any rules the previous page installed.
  if (changeInfo.status === "loading" && changeInfo.url) {
    clearTabMediaRules(tabId);
  }
});

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------

function broadcastState() {
  // Tell every Crimson tab the enabled flag flipped, so the page UI updates
  // live without a poll. Best-effort; tabs without our content script ignore it.
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      if (tab.id === undefined) continue;
      chrome.tabs
        .sendMessage(tab.id, { kind: CRX.BROADCAST_STATE, enabled })
        .catch(() => {});
    }
  });
}

// Page-facing messages arrive from the content script (sender.tab is set).
// Popup messages arrive from the extension itself (sender.tab is undefined).
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender && sender.tab ? sender.tab.id : undefined;

  (async () => {
    // Ensure persisted state (esp. `enabled`) is loaded before we answer — the SW
    // may have just cold-started for this very message. Without this, the first
    // FETCH/HELLO after an idle teardown can wrongly report "disabled".
    try {
      await readyPromise;
    } catch (_) {
      /* loadState is best-effort; fall through with whatever we have. */
    }
    switch (msg && msg.kind) {
      // ---- handshake / status (allowed even when disabled) ----
      case CRX.HELLO:
      case CRX.STATUS: {
        // A fresh handshake from a tab also resets that tab's media rules — the
        // page is (re)initialising and will reinstall what it needs.
        if (msg.kind === CRX.HELLO && tabId !== undefined) {
          await clearTabMediaRules(tabId);
        }
        sendResponse({
          ok: true,
          protocol: CRX.PROTOCOL,
          version: CRX.VERSION,
          enabled,
        });
        return;
      }

      // ---- popup control surface ----
      case CRX.POPUP_GET_STATE: {
        sendResponse({ ok: true, enabled, version: CRX.VERSION, stats });
        return;
      }
      case CRX.POPUP_SET_ENABLED: {
        await setEnabled(msg.enabled);
        sendResponse({ ok: true, enabled });
        return;
      }

      // ---- privileged work (gated on enabled) ----
      case CRX.FETCH: {
        if (!enabled) return sendResponse({ ok: false, error: "disabled" });
        sendResponse(await doFetch(msg.payload));
        return;
      }
      case CRX.MEDIA_RULES: {
        if (!enabled) return sendResponse({ ok: false, error: "disabled" });
        sendResponse(await installMediaRules(msg.payload, tabId));
        return;
      }
      case CRX.CLEAR_RULES: {
        // Allowed even when disabled (cleanup should always work).
        sendResponse(await clearRules(msg.payload, tabId));
        return;
      }

      default:
        sendResponse({ ok: false, error: "unknown message kind" });
    }
  })();

  // Keep the message channel open for the async sendResponse above.
  return true;
});
