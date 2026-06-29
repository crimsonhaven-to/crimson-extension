/*
 * crimson-extension — shared protocol constants.
 *
 * Loaded into BOTH the service worker (via importScripts) and the isolated-world
 * content script (listed in manifest content_scripts). It defines a single
 * global, `CRX`, that both contexts read. The MAIN-world in-page API
 * (src/inpage.js) keeps its own copy of the few string tags it needs (it runs in
 * the page's JS world and can't see this global) — keep them in sync.
 *
 * Channel overview:
 *
 *   page (MAIN world, window.CrimsonExtension)
 *      │  window.postMessage({channel: REQ, ...})
 *      ▼
 *   content.js (ISOLATED world)
 *      │  chrome.runtime.sendMessage(...)
 *      ▼
 *   background.js (service worker)  ── does the privileged work ──┐
 *      ▲                                                          │
 *      └──────────── response ────────────────────────────────────┘
 *   content.js  ── window.postMessage({channel: RES, ...}) ──▶ page
 */
(function (root) {
  const CRX = {
    VERSION: "1.0.3",
    // Bump when the message shape changes incompatibly; crimson-sources can
    // refuse an older companion.
    PROTOCOL: 1,

    // window.postMessage channels (page <-> content script).
    REQ: "crimson-ext:req", // page -> content -> SW
    RES: "crimson-ext:res", // SW -> content -> page (correlated by id)
    EVENT: "crimson-ext:event", // SW/content -> page (unsolicited, e.g. enabled changed)

    // Message kinds (the `kind` field of a REQ, and of runtime messages).
    HELLO: "hello", // handshake + capability/enabled probe
    FETCH: "fetch", // privileged cross-origin fetch with header injection
    MEDIA_RULES: "media_rules", // install DNR header+CORS rules for the tab's media fetches
    CLEAR_RULES: "clear_rules", // remove previously installed media rules
    STATUS: "status", // current enabled flag (no work)

    // Popup <-> SW (runtime messages, not page-facing).
    POPUP_GET_STATE: "popup_get_state",
    POPUP_SET_ENABLED: "popup_set_enabled",

    // SW -> content broadcast kind (relayed to the page as an EVENT).
    BROADCAST_STATE: "broadcast_state",

    // Storage keys.
    STORE_ENABLED: "enabled",
    STORE_STATS: "stats",

    // DNR session-rule id ranges, kept disjoint so the two rule families never
    // collide. FETCH rules are ephemeral (added then removed around one fetch);
    // MEDIA rules live until the page clears them or its tab goes away.
    FETCH_RULE_MIN: 1,
    FETCH_RULE_MAX: 699999,
    MEDIA_RULE_MIN: 700000,
    MEDIA_RULE_MAX: 999999,
  };

  root.CRX = CRX;
})(typeof self !== "undefined" ? self : this);
