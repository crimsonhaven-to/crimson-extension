/*
 * crimson-extension: resolve-in-page helpers shared with the desktop app.
 *
 * Loaded into the service worker (importScripts) and the Firefox event page
 * (manifest background.scripts). crimson-native vendors this repo and reads this
 * file too, so its hidden capture windows nudge players and match media URLs
 * exactly like the extension. Keep it self-contained: no chrome.* calls and no
 * references to anything defined elsewhere.
 */

// The first request matching this, from the capture tab, is the stream.
const MEDIA_URL_RE = /\.(m3u8|mp4)(\?|#|$)/i;

// Injected into the resolve-in-page tab (and every frame) to start playback the
// way a user click would. Some SPA embeds — notably Filemoon's "Byse" player —
// only fetch the .m3u8 once playback is *initiated*, so a pure network-watch tab
// would sit idle until someone hits play by hand. This nudges it: unmute-safe
// muted play() (allowed for background tabs), a JWPlayer .play() if the page
// exposes one, and a click on the usual play affordances. Self-contained (no
// outer scope), idempotent, and swallows every error so a hostile embed can't
// break the SW. Deliberately narrow selectors so we don't click ad chrome.
//
// First it spoofs the Page Visibility API to report the tab as visible+focused.
// The capture tab always runs *backgrounded* now (never focus-steals, so the
// client keeps fullscreen across episode changes), but some ad-SPA players
// (Vidking) gate autoplay on `document.hidden`/`visibilityState` and simply won't
// start — nor fetch their stream — in a tab they think is hidden. Faking visibility
// flips that gate without ever making the tab visible for real. Harmless for
// players that don't care (Filemoon). It can't defeat the browser's own rAF/timer
// throttling of background tabs, only the page's *JS-readable* visibility checks.
function crimsonPlayNudge() {
  try {
    if (!document.__crimsonVisSpoof) {
      Object.defineProperty(document, "__crimsonVisSpoof", { value: true });
      const fake = (obj, prop, val) => {
        try {
          Object.defineProperty(obj, prop, { configurable: true, get: () => val });
        } catch (_) {
          /* non-configurable on this engine — ignore */
        }
      };
      fake(document, "hidden", false);
      fake(document, "webkitHidden", false);
      fake(document, "visibilityState", "visible");
      fake(document, "webkitVisibilityState", "visible");
      try {
        document.hasFocus = () => true;
      } catch (_) {
        /* ignore */
      }
      // Swallow the events that would tell a player it just went hidden/unfocused.
      // Registered capture-phase and first (we run before the page's own scripts on
      // most ticks), so stopImmediatePropagation keeps them from ever seeing it.
      const swallow = (e) => {
        try {
          e.stopImmediatePropagation();
        } catch (_) {
          /* ignore */
        }
      };
      for (const type of ["visibilitychange", "webkitvisibilitychange", "blur", "pagehide"]) {
        try {
          window.addEventListener(type, swallow, true);
          document.addEventListener(type, swallow, true);
        } catch (_) {
          /* ignore */
        }
      }
    }
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
    // Dispatch a full pointer+mouse sequence at the element's real centre instead of
    // a bare el.click(). A lot of "is this a real user?" gate handlers (bs.to's
    // .hoster-player among them) don't just look at isTrusted — they read clientX/Y,
    // button, and expect the pointerdown→mousedown→mouseup→click order a real click
    // produces. A coordinate-less el.click() fails those; this passes the ones that
    // don't hard-require isTrusted, and is a harmless no-op for players that ignore it.
    const realClick = (el) => {
      const r = el.getBoundingClientRect();
      const cx = Math.round(r.left + r.width / 2);
      const cy = Math.round(r.top + r.height / 2);
      const base = { bubbles: true, cancelable: true, composed: true, view: window, clientX: cx, clientY: cy, button: 0, buttons: 1 };
      const pointer = { ...base, pointerId: 1, pointerType: "mouse", isPrimary: true };
      try { el.dispatchEvent(new PointerEvent("pointerover", pointer)); } catch (_) {}
      try { el.dispatchEvent(new PointerEvent("pointerenter", pointer)); } catch (_) {}
      try { el.dispatchEvent(new MouseEvent("mouseover", base)); } catch (_) {}
      try { el.dispatchEvent(new PointerEvent("pointerdown", pointer)); } catch (_) {}
      try { el.dispatchEvent(new MouseEvent("mousedown", base)); } catch (_) {}
      try { el.dispatchEvent(new PointerEvent("pointerup", { ...pointer, buttons: 0 })); } catch (_) {}
      try { el.dispatchEvent(new MouseEvent("mouseup", { ...base, buttons: 0 })); } catch (_) {}
      try { el.dispatchEvent(new MouseEvent("click", { ...base, buttons: 0 })); } catch (_) {}
      try { el.click(); } catch (_) { /* detached / cross-doc — ignore */ }
    };
    // Reveal triggers: elements that, when clicked, make the actual player/embed
    // appear (bs.to's .hoster-player POSTs ajax/embed.php and injects the hoster
    // iframe only after a click). These must be clicked ONCE — re-clicking every
    // tick would re-POST and stack duplicate iframes — so each element is marked
    // and skipped on later ticks. Fresh elements (a second hoster row) still get one.
    const revealSels = [".hoster-player", "[data-hoster]", ".hoster a", ".watch a.hoster"];
    for (const sel of revealSels) {
      for (const el of document.querySelectorAll(sel)) {
        if (el.__crimsonNudged) continue;
        try { Object.defineProperty(el, "__crimsonNudged", { value: true }); } catch (_) { el.__crimsonNudged = true; }
        realClick(el);
      }
    }
    // Play affordances: overlay buttons on a player that already exists. Idempotent to
    // re-hit (an already-playing player ignores them), so these run every tick.
    const playSels = [
      ".jw-icon-display",
      ".jw-display-icon-container",
      ".vjs-big-play-button",
      ".plyr__control--overlaid",
      "button[aria-label*='play' i]",
      "button[title*='play' i]",
      "#play",
      ".play-button",
    ];
    for (const sel of playSels) {
      const el = document.querySelector(sel);
      if (el) realClick(el);
    }
  } catch (_) {
    /* never let the nudge throw into the injector */
  }
}
