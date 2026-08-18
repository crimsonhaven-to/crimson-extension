/*
 * crimson-extension — content script (isolated world).
 *
 * The bridge. It does no privileged work itself; it just relays messages both
 * ways between the MAIN-world API (src/inpage.js) and the service worker:
 *
 *   page  --window.postMessage(REQ)-->  here  --runtime.sendMessage-->  SW
 *   SW    --sendResponse-->             here  --window.postMessage(RES)-->  page
 *   SW    --tabs.sendMessage(BROADCAST)--> here --postMessage(EVENT)--> page
 *
 * src/inpage.js is injected by the browser as a separate `world: "MAIN"` content
 * script (see manifest), NOT by this file — a page DOM <script> would be blocked
 * by a strict `script-src 'self'` CSP, whereas a MAIN-world content script is
 * exempt. The two share only the DOM `window` for postMessage, never JS scope.
 *
 * `CRX` comes from src/protocol.js, listed before this file in the manifest.
 */
(function () {
  // page -> SW relay.
  window.addEventListener("message", (event) => {
    // Only accept messages this window posted to itself in our REQ channel.
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.channel !== CRX.REQ || typeof data.id !== "number") return;

    const respond = (payload) => {
      window.postMessage(
        { channel: CRX.RES, id: data.id, ...payload },
        event.origin === "null" ? "*" : event.origin
      );
    };

    let replied = false;
    try {
      chrome.runtime.sendMessage(
        { kind: data.kind, payload: data.payload },
        (resp) => {
          replied = true;
          if (chrome.runtime.lastError) {
            respond({ ok: false, error: chrome.runtime.lastError.message });
          } else {
            respond(resp || { ok: false, error: "no response" });
          }
        }
      );
    } catch (e) {
      respond({ ok: false, error: String(e && e.message ? e.message : e) });
      return;
    }

    // If the SW was asleep and the channel died, fail rather than hang. Generous
    // enough to cover a resolve-in-page capture (a real page load + PoW can take
    // tens of seconds); the SW answers well before this for every other kind.
    setTimeout(() => {
      if (!replied) respond({ ok: false, error: "extension timeout" });
    }, 60000);
  });

  // SW -> page relay (unsolicited broadcasts, e.g. enabled toggled).
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.kind === CRX.BROADCAST_STATE) {
      window.postMessage(
        { channel: CRX.EVENT, event: "state", enabled: Boolean(msg.enabled) },
        window.location.origin
      );
    }
  });
})();
