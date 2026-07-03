/*
 * crimson-extension — resolve-in-page iframe wrapper.
 *
 * The top-level page of a resolve-in-page capture tab when the source requests
 * `frame:true` (see background.js resolveInPage). Some embed players — Vidking —
 * are built to run *inside an iframe* and self-destruct (close/redirect) the moment
 * they detect they're the top-level window. Framing the embed here gives them the
 * context they expect; the service worker still captures the .m3u8 the framed player
 * fetches, because its webRequest listener is scoped to this tab and so sees the
 * subframe's requests too.
 *
 * `referrerpolicy=no-referrer` mimics a fresh/typed navigation (no Referer) — what
 * these players accept; `allow=autoplay` lets the framed player start on its own so
 * it fetches the stream without a manual click.
 */
(function () {
  var embed = new URLSearchParams(location.search).get("embed");
  // Only ever frame a real http(s) embed — never a javascript:/data:/blob: URL.
  if (!embed || !/^https?:\/\//i.test(embed)) return;

  var frame = document.createElement("iframe");
  frame.src = embed;
  frame.referrerPolicy = "no-referrer";
  frame.allow = "autoplay; encrypted-media; fullscreen";
  frame.setAttribute("allowfullscreen", "");
  document.body.appendChild(frame);
})();
