/*
 * crimson-extension — in-page API (MAIN world).
 *
 * Runs in the PAGE's JS world, so it can't touch chrome.* — it talks to the
 * content-script bridge over window.postMessage and exposes a clean, promise-
 * based `window.CrimsonExtension` that crimson-sources codes against.
 *
 * It is injected by the browser as a `world: "MAIN"` content script (see the
 * manifest), not by a page DOM <script> — so a strict `script-src 'self'` CSP on
 * the host page can't block it (DOM-injected extension scripts would be).
 *
 * Detection from page code (no extension id needed):
 *
 *   if (window.CrimsonExtension?.available) { ... }
 *   // or, for code that runs before this script:
 *   document.documentElement.dataset.crimsonExt  // = version string when present
 *
 * Usage sketch (crimson-sources):
 *
 *   const ext = window.CrimsonExtension;
 *   const { enabled } = await ext.hello();
 *   if (enabled) {
 *     const r = await ext.fetch(embedUrl, { headers: { Referer: "https://voe.sx/" } });
 *     // r.body is the page HTML; parse it locally.
 *     await ext.installMediaRules([
 *       { requestDomains: ["cloudwindow-route.com"],
 *         requestHeaders: { Referer: "https://voe.sx/", "User-Agent": UA }, cors: true },
 *     ]);
 *     // ...then point hls.js straight at the CDN URL.
 *   }
 *
 * The string tags below MUST match src/protocol.js (this file can't import it).
 */
(function () {
  if (window.CrimsonExtension) return; // idempotent (script injected once)

  const REQ = "crimson-ext:req";
  const RES = "crimson-ext:res";
  const EVENT = "crimson-ext:event";
  const KIND = {
    HELLO: "hello",
    FETCH: "fetch",
    MEDIA_RULES: "media_rules",
    CLEAR_RULES: "clear_rules",
    STATUS: "status",
  };

  // Kept in sync with src/protocol.js (CRX.VERSION / CRX.PROTOCOL). As a MAIN-world
  // content script there's no injected <script> dataset to read these from.
  const VERSION = "1.0.2";
  const PROTOCOL = 1;

  let seq = 0;
  const pending = new Map(); // id -> {resolve, reject, timer}
  const listeners = new Set(); // state-change callbacks
  let lastEnabled = null; // cached enabled flag from hello()/events

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data) return;

    if (data.channel === RES && typeof data.id === "number") {
      const entry = pending.get(data.id);
      if (!entry) return;
      pending.delete(data.id);
      clearTimeout(entry.timer);
      // Mirror enabled state when the SW reports it.
      if (typeof data.enabled === "boolean") setEnabled(data.enabled);
      entry.resolve(data);
      return;
    }

    if (data.channel === EVENT && data.event === "state") {
      setEnabled(Boolean(data.enabled));
    }
  });

  function setEnabled(next) {
    if (next === lastEnabled) return;
    lastEnabled = next;
    for (const cb of listeners) {
      try {
        cb(next);
      } catch (_) {
        /* a bad listener shouldn't break the others */
      }
    }
  }

  function call(kind, payload, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("crimson-extension: request timed out"));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      window.postMessage({ channel: REQ, id, kind, payload }, window.location.origin);
    });
  }

  const api = {
    available: true,
    version: VERSION,
    protocol: PROTOCOL,

    /** Handshake + capability probe. Resolves {ok, protocol, version, enabled}. */
    async hello() {
      const r = await call(KIND.HELLO);
      return r;
    },

    /** Cheap enabled check (no privileged work). */
    async status() {
      const r = await call(KIND.STATUS);
      return Boolean(r && r.enabled);
    },

    /** Last enabled value we heard, or null if we haven't asked yet. */
    get enabled() {
      return lastEnabled;
    },

    /**
     * Privileged cross-origin fetch with header injection.
     * @param {string} url
     * @param {object} [opts] - { method, headers, body, redirect, credentials,
     *                            responseType: "text" | "arraybuffer" }
     * @returns {Promise<{ok, status, statusText, url, headers, body, bodyEncoding}>}
     */
    async fetch(url, opts = {}) {
      const r = await call(KIND.FETCH, { url, ...opts });
      if (!r.ok) throw new Error(`crimson-extension fetch failed: ${r.error}`);
      return r;
    },

    /**
     * Install declarative header+CORS rules for THIS tab's media fetches, so the
     * player can stream gated CDN segments directly. Returns { ruleIds } for a
     * later clearMediaRules().
     * @param {Array<{requestDomains?:string[], urlFilter?:string,
     *                requestHeaders?:object, cors?:boolean,
     *                resourceTypes?:string[]}>} rules
     * @param {{replace?:boolean}} [opts] - replace (default true) drops this
     *        tab's previous media rules first.
     */
    async installMediaRules(rules, opts = {}) {
      const r = await call(KIND.MEDIA_RULES, { rules, replace: opts.replace });
      if (!r.ok) throw new Error(`crimson-extension media rules failed: ${r.error}`);
      return r;
    },

    /** Remove media rules (specific ids, or all of this tab's when omitted). */
    async clearMediaRules(ruleIds) {
      const r = await call(KIND.CLEAR_RULES, { ruleIds });
      return Boolean(r && r.ok);
    },

    /** Subscribe to enabled on/off changes. Returns an unsubscribe fn. */
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };

  Object.defineProperty(window, "CrimsonExtension", {
    value: Object.freeze(api),
    writable: false,
    configurable: false,
  });
  document.documentElement.dataset.crimsonExt = VERSION;
  window.dispatchEvent(
    new CustomEvent("crimson-extension-ready", { detail: { version: VERSION, protocol: PROTOCOL } })
  );
})();
