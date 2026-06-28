/*
 * crimson-extension — content script (isolated world).
 *
 * The bridge. It does no privileged work itself; it (a) injects the MAIN-world
 * API (src/inpage.js) so page code gets a clean `window.CrimsonExtension`, and
 * (b) relays messages both ways:
 *
 *   page  --window.postMessage(REQ)-->  here  --runtime.sendMessage-->  SW
 *   SW    --sendResponse-->             here  --window.postMessage(RES)-->  page
 *   SW    --tabs.sendMessage(BROADCAST)--> here --postMessage(EVENT)--> page
 *
 * `CRX` comes from src/protocol.js, listed before this file in the manifest.
 */
(function () {
  // 1) Inject the MAIN-world API into the page.
  try {
    const s = document.createElement("script");
    s.src = chrome.runtime.getURL("src/inpage.js");
    s.dataset.crxVersion = CRX.VERSION;
    s.dataset.crxProtocol = String(CRX.PROTOCOL);
    (document.head || document.documentElement).appendChild(s);
    // Remove the tag once it's run; the API object persists on window.
    s.onload = () => s.remove();
  } catch (_) {
    /* CSP could block this in theory; the page can still detect absence. */
  }

  // 2) page -> SW relay.
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

    // If the SW was asleep and the channel died, fail rather than hang.
    setTimeout(() => {
      if (!replied) respond({ ok: false, error: "extension timeout" });
    }, 30000);
  });

  // 3) SW -> page relay (unsolicited broadcasts, e.g. enabled toggled).
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.kind === CRX.BROADCAST_STATE) {
      window.postMessage(
        { channel: CRX.EVENT, event: "state", enabled: Boolean(msg.enabled) },
        window.location.origin
      );
    }
  });
})();
