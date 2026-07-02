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

// True iff the user has granted our optional broad host permission. Every
// privileged capability (cross-origin FETCH, DNR header/CORS injection, and
// resolve-in-page) needs it, so without the grant we stay dark. The permission
// is requested from the popup on enable (it needs a user gesture, which the SW
// doesn't have).
async function hasHostAccess() {
  try {
    return await chrome.permissions.contains({ origins: ["<all_urls>"] });
  } catch (_) {
    return false;
  }
}

async function loadState() {
  const got = await chrome.storage.local.get([CRX.STORE_ENABLED]);
  // Effective `enabled` = "the user wants it on" AND "host access is granted".
  // A fresh install has no grant yet, so it starts OFF until the user flips the
  // popup switch (which triggers the permission prompt). We still remember an
  // explicit toggle-off as `false`. Revoking the grant from chrome://extensions
  // later also flips us off, honestly, on the next load — see permissions
  // .onRemoved below for the live case.
  const stored = got[CRX.STORE_ENABLED];
  const wantEnabled = stored === undefined ? true : Boolean(stored);
  enabled = wantEnabled && (await hasHostAccess());
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
// Reconcile dynamically-registered Haven bridges too (registered scripts persist,
// but re-syncing after an update or a revocation keeps them honest).
syncHavens();
chrome.runtime.onInstalled.addListener(() => {
  readyPromise = loadState();
  syncHavens();
});
chrome.runtime.onStartup.addListener(() => {
  readyPromise = loadState();
  syncHavens();
});

// If the user revokes our host access from chrome://extensions while we're
// running, we can no longer do privileged work — go dark immediately (drop every
// rule, flip the switch off, update the UI) so behaviour stays honest without
// waiting for a reload.
chrome.permissions.onRemoved.addListener(async () => {
  // A specific Haven origin may have been revoked from chrome://extensions —
  // reconcile registrations so we stop injecting where we're no longer allowed.
  await syncHavens();
  if (await hasHostAccess()) return; // broad grant intact; nothing else to do
  enabled = false;
  await clearAllRules();
  await refreshActionUI();
  broadcastState();
});

async function setEnabled(next) {
  const want = Boolean(next);
  // Never report "on" without host access — the popup owns requesting the grant
  // (it needs a user gesture) before asking us to enable. If it somehow asks
  // without the grant in place, refuse rather than pretend to work.
  if (want && !(await hasHostAccess())) {
    enabled = false;
    await refreshActionUI();
    broadcastState();
    return { ok: false, error: "host permission not granted" };
  }
  enabled = want;
  await chrome.storage.local.set({ [CRX.STORE_ENABLED]: enabled });
  if (!enabled) {
    // Going dark: rip out every rule we own so we stop touching traffic.
    await clearAllRules();
  }
  await refreshActionUI();
  broadcastState();
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Dynamic Haven registration
//
// The static manifest content_scripts only match crimsonhaven.to + localhost.
// To make the companion work on a self-hosted instance running on its OWN
// domain, the user adds that origin from the popup: the popup requests host
// permission for it (a user gesture, so it must live there), then asks us to
// register the SAME two bridge scripts the manifest declares — the MAIN-world
// in-page API and the isolated-world relay — for that origin. Registered
// scripts persist across sessions; we reconcile them on install/startup and
// drop any whose host permission was later revoked.
// ---------------------------------------------------------------------------

// Portless "scheme://host" -> a "scheme://host/*" match pattern. Match patterns
// can't carry a port, so callers pass portless origins (the popup normalises).
function siteToMatch(site) {
  return site.replace(/\/+$/, "") + "/*";
}

// Deterministic, collision-free script ids for an origin, so add/remove/reconcile
// all address the exact same pair.
function siteScriptIds(site) {
  const key = encodeURIComponent(site);
  return { iso: `haven-iso:${key}`, main: `haven-main:${key}` };
}

async function unregisterScriptIds(ids) {
  try {
    const have = await chrome.scripting.getRegisteredContentScripts({ ids });
    const present = have.map((s) => s.id);
    if (present.length) await chrome.scripting.unregisterContentScripts({ ids: present });
  } catch (_) {
    /* nothing registered under these ids — fine */
  }
}

// Register the bridge for one origin. Mirrors the manifest's two content_scripts
// (MAIN: inpage.js; ISOLATED: protocol.js + content.js), at document_start.
// Idempotent: drops any existing pair for this origin first.
async function registerHaven(site) {
  const ids = siteScriptIds(site);
  await unregisterScriptIds([ids.iso, ids.main]);
  await chrome.scripting.registerContentScripts([
    {
      id: ids.iso,
      matches: [siteToMatch(site)],
      js: ["src/protocol.js", "src/content.js"],
      world: "ISOLATED",
      runAt: "document_start",
      allFrames: false,
      persistAcrossSessions: true,
    },
    {
      id: ids.main,
      matches: [siteToMatch(site)],
      js: ["src/inpage.js"],
      world: "MAIN",
      runAt: "document_start",
      allFrames: false,
      persistAcrossSessions: true,
    },
  ]);
}

async function getHavens() {
  const got = await chrome.storage.local.get([CRX.STORE_SITES]);
  const list = got[CRX.STORE_SITES];
  return Array.isArray(list) ? list : [];
}

async function setHavens(list) {
  await chrome.storage.local.set({ [CRX.STORE_SITES]: list });
}

// Popup flow: the user already granted host permission for `site` (from the
// popup gesture); we register the bridge and remember the origin.
async function addHaven(site) {
  if (!site || !/^https?:\/\/[^/]+$/.test(site)) {
    return { ok: false, error: "invalid site" };
  }
  // Guard: never register on an origin we weren't actually granted.
  let granted = false;
  try {
    granted = await chrome.permissions.contains({ origins: [siteToMatch(site)] });
  } catch (_) {
    granted = false;
  }
  if (!granted) return { ok: false, error: "permission not granted" };

  try {
    await registerHaven(site);
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
  const list = await getHavens();
  if (!list.includes(site)) {
    list.push(site);
    await setHavens(list);
  }
  return { ok: true, havens: list };
}

async function removeHaven(site) {
  const ids = siteScriptIds(site);
  await unregisterScriptIds([ids.iso, ids.main]);
  // Give the host permission back too, so removing a site fully reverses the add.
  // A no-op when the broad <all_urls> grant (from enabling) still covers it.
  try {
    await chrome.permissions.remove({ origins: [siteToMatch(site)] });
  } catch (_) {
    /* can't drop a sub-pattern of a broader grant — harmless */
  }
  const list = (await getHavens()).filter((s) => s !== site);
  await setHavens(list);
  return { ok: true, havens: list };
}

// Reconcile stored Havens with reality (install/startup, and after a revocation):
// re-register the ones we still hold permission for, and drop the rest.
async function syncHavens() {
  const list = await getHavens();
  const kept = [];
  for (const site of list) {
    let granted = false;
    try {
      granted = await chrome.permissions.contains({ origins: [siteToMatch(site)] });
    } catch (_) {
      granted = false;
    }
    if (granted) {
      try {
        await registerHaven(site);
        kept.push(site);
      } catch (_) {
        /* registration failed (bad pattern?) — drop it below */
      }
    } else {
      await unregisterScriptIds(Object.values(siteScriptIds(site)));
    }
  }
  if (kept.length !== list.length) await setHavens(kept);
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
// Capability 3: resolve-in-page (hidden-tab stream capture).
//
// Some hosters can't be cracked by a static fetch+parse: their player is an SPA
// that runs a proof-of-work + in-browser decrypt (Filemoon "Byse"), or it bails
// when it detects DevTools (Movish rtcore). The robust answer is to let the page
// do its OWN work in a real browser tab and just *watch the network*: we open the
// embed in a background tab, capture the first media (.m3u8/.mp4) request it makes
// (plus the Referer/Origin/UA it used), then close the tab. No reverse-engineering,
// no DevTools (so anti-debug never trips), and the page's PoW/decrypt runs for real.
// ---------------------------------------------------------------------------

const MEDIA_URL_RE = /\.(m3u8|mp4)(\?|#|$)/i;

function streamTypeForUrl(u) {
  return /\.m3u8(\?|#|$)/i.test(u) ? "hls" : "mp4";
}

// Injected into the resolve-in-page tab (and every frame) to start playback the
// way a user click would. Some SPA embeds — notably Filemoon's "Byse" player —
// only fetch the .m3u8 once playback is *initiated*, so a pure network-watch tab
// would sit idle until someone hits play by hand. This nudges it: unmute-safe
// muted play() (allowed for background tabs), a JWPlayer .play() if the page
// exposes one, and a click on the usual play affordances. Self-contained (no
// outer scope), idempotent, and swallows every error so a hostile embed can't
// break the SW. Deliberately narrow selectors so we don't click ad chrome.
function crimsonPlayNudge() {
  try {
    for (const v of document.querySelectorAll("video, audio")) {
      try {
        v.muted = true;
        const p = v.play();
        if (p && typeof p.catch === "function") p.catch(() => {});
      } catch (_) {
        /* autoplay policy / detached element — ignore */
      }
    }
    try {
      if (typeof window.jwplayer === "function") {
        const jw = window.jwplayer();
        if (jw && typeof jw.play === "function") jw.play(true);
      }
    } catch (_) {
      /* not a JW page, or jwplayer() threw — ignore */
    }
    const sels = [
      ".jw-icon-display",
      ".jw-display-icon-container",
      ".vjs-big-play-button",
      ".plyr__control--overlaid",
      "button[aria-label*='play' i]",
      "button[title*='play' i]",
      "#play",
      ".play-button",
    ];
    for (const sel of sels) {
      const el = document.querySelector(sel);
      if (el) {
        try {
          el.click();
        } catch (_) {
          /* ignore */
        }
      }
    }
  } catch (_) {
    /* never let the nudge throw into the injector */
  }
}

async function resolveInPage(payload) {
  const url = payload && payload.url;
  if (!url || typeof url !== "string") return { ok: false, error: "missing url" };
  let timeoutMs = Number(payload.timeoutMs) || CRX.RESOLVE_DEFAULT_TIMEOUT;
  if (timeoutMs > CRX.RESOLVE_MAX_TIMEOUT) timeoutMs = CRX.RESOLVE_MAX_TIMEOUT;

  // Optional substring(s) the captured media URL must contain (e.g. a known CDN
  // marker), to skip ad/pre-roll media. Empty => accept the first media request.
  const want = Array.isArray(payload.mustInclude) ? payload.mustInclude : [];
  const matchesWant = (u) => want.length === 0 || want.some((w) => u.includes(w));

  let tab;
  try {
    tab = await chrome.tabs.create({ url, active: false });
  } catch (e) {
    return { ok: false, error: "tab create failed: " + (e && e.message ? e.message : e) };
  }
  const tabId = tab.id;

  // Embed pages (Filemoon/Movish & co.) spawn ad popunders via window.open. Those
  // popups have our throwaway tab as their opener (directly or transitively), so we
  // track them and close them together with the embed tab when resolving finishes —
  // otherwise tidying only the embed tab would leave its popups orphaned in the
  // user's browser (the "stray tabs left open" behaviour). We never capture media
  // from these (the webRequest listener is scoped to the embed tab), so closing
  // them can't drop the real stream.
  const spawned = new Set();
  const onCreated = (t) => {
    if (!t || t.id === undefined || t.id === tabId) return;
    if (t.openerTabId === tabId || (t.openerTabId !== undefined && spawned.has(t.openerTabId))) {
      spawned.add(t.id);
    }
  };
  try {
    chrome.tabs.onCreated.addListener(onCreated);
  } catch (_) {
    /* tabs.onCreated unavailable — we just won't auto-tidy popups */
  }

  return new Promise((resolve) => {
    let done = false;

    // Re-inject the play nudge on a short cadence rather than once on load: the
    // SPA renders its player (and any child iframe) after the page reports
    // "complete", and cross-origin frames appear late, so a single shot would
    // miss them. Each tick injects into every frame that exists right then; the
    // nudge is idempotent, so hitting an already-playing player is a no-op.
    const nudge = () => {
      if (done || tabId === undefined) return;
      chrome.scripting
        .executeScript({
          target: { tabId, allFrames: true },
          world: "MAIN",
          func: crimsonPlayNudge,
        })
        .catch(() => {
          /* tab still on about:blank, navigating, or gone — next tick retries */
        });
    };
    const nudgeTimer = setInterval(nudge, 1200);
    // First attempt a touch after creation so the initial document exists.
    setTimeout(nudge, 800);

    const onSend = (details) => {
      if (done || details.tabId !== tabId) return;
      if (!MEDIA_URL_RE.test(details.url) || !matchesWant(details.url)) return;
      const h = {};
      for (const { name, value } of details.requestHeaders || []) {
        const n = name.toLowerCase();
        if (n === "referer") h.referer = value;
        else if (n === "origin") h.origin = value;
        else if (n === "user-agent") h.userAgent = value;
      }
      finish({ ok: true, url: details.url, streamType: streamTypeForUrl(details.url), headers: h });
    };

    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(nudgeTimer);
      try {
        chrome.webRequest.onSendHeaders.removeListener(onSend);
      } catch (_) {
        /* ignore */
      }
      try {
        chrome.tabs.onCreated.removeListener(onCreated);
      } catch (_) {
        /* ignore */
      }
      // Tidy up the throwaway embed tab AND every popup it spawned. Remove each
      // individually so one already-closed tab doesn't abort closing the rest
      // (chrome.tabs.remove rejects the whole batch if any id is gone).
      const toClose = new Set(spawned);
      if (tabId !== undefined) toClose.add(tabId);
      for (const id of toClose) chrome.tabs.remove(id).catch(() => {});
      resolve(result);
    };

    const timer = setTimeout(
      () => finish({ ok: false, error: "resolve-in-page timed out (no media request)" }),
      timeoutMs,
    );

    try {
      chrome.webRequest.onSendHeaders.addListener(
        onSend,
        { urls: ["<all_urls>"], tabId },
        ["requestHeaders", "extraHeaders"],
      );
    } catch (e) {
      finish({ ok: false, error: "webRequest listen failed: " + (e && e.message ? e.message : e) });
    }
  });
}

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
        sendResponse({ ok: true, enabled, version: CRX.VERSION, stats, havens: await getHavens() });
        return;
      }
      case CRX.POPUP_SET_ENABLED: {
        const r = await setEnabled(msg.enabled);
        sendResponse({ ok: r.ok, enabled, error: r.error });
        return;
      }
      case CRX.POPUP_ADD_SITE: {
        sendResponse(await addHaven(msg.site));
        return;
      }
      case CRX.POPUP_REMOVE_SITE: {
        sendResponse(await removeHaven(msg.site));
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
      case CRX.RESOLVE_IN_PAGE: {
        if (!enabled) return sendResponse({ ok: false, error: "disabled" });
        sendResponse(await resolveInPage(msg.payload));
        return;
      }

      default:
        sendResponse({ ok: false, error: "unknown message kind" });
    }
  })();

  // Keep the message channel open for the async sendResponse above.
  return true;
});
