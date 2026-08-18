# crimson-extension 🦇

The **Crimson Haven Companion** — a tiny Chromium (Chrome/Edge, MV3) extension
whose only job is **local CORS unblock + header injection** for
[Crimson Haven](https://crimsonhaven.to).

It is the first building block of the [New System](../crimson-backend/New_System.md):
moving scraping/resolving off the backend and into the viewer's browser. The
extension is the *most capable* execution environment — with it installed, the
site (`crimson-client` + `crimson-sources`) can scrape gated sources and play
their streams **straight from your browser to the CDN**, with neither the backend
nor the cors-proxy in the byte path.

> One red button. Press **Use Extension** and the rest happens in the
> background. There is no other UI and nothing to configure.

## What it does (and deliberately does *not*)

It does three things at the network layer (the first two are the core; the third is
a last-resort capability for hosters static scraping can't crack):

1. **`fetch` RPC** — a privileged cross-origin fetch the page can call. The
   extension performs the request from its service worker (which has host access,
   so **no CORS wall**) and injects any headers the page asks for — *including the
   forbidden ones a page can never set itself*: `Referer`, `Origin`,
   `User-Agent`, `Cookie`, `Sec-Fetch-*`. The response body is handed back to the
   page. This is what lets a client-side scraper walk an embed page / hit a gated
   API the way the Python backend does today.

2. **Media unblock rules** — declarative `Referer`/`Origin`/`User-Agent` header
   injection **plus** `Access-Control-Allow-Origin: *` on the response, applied to
   the **page's own** `hls.js`/`<video>` media fetches and scoped to that tab. The
   player then streams gated CDN segments directly. This is the bandwidth win:
   `CDN → viewer`, nothing in between.

3. **`resolveInPage` — hidden-tab capture** (v1.0.4+, protocol 2). For SPA / proof-of-work
   / anti-devtools hosters a static fetch can't crack, the SW opens the embed in a
   **background tab**, lets the page do its own work, captures the first `.m3u8`/`.mp4`
   request **+ its Referer/Origin/UA** via `chrome.webRequest`, then closes the tab. We
   reverse nothing, and watching the network never trips DevTools detection. **v1.0.5:**
   ad popunders the embed spawns (`window.open`) are tracked by opener and closed together
   with the throwaway tab when resolving finishes — no stray tabs left open. **v1.0.6:** a
   play nudge (`chrome.scripting`) is injected into the tab and every frame on a short
   cadence — muted `play()` + JWPlayer `.play()` + a click on the usual play affordances —
   so lazy SPA players that only fetch the `.m3u8` once playback starts no longer need a
   manual click to resolve. **v1.1.2:** an opt-in `active:true` opens the throwaway tab
   *focused* (and restores the user's previous tab the moment it resolves) — some ad-SPA
   players (Vidking) only autoplay, and thus only fetch their stream, while their tab is the
   visible one; a backgrounded tab is `document.hidden`, so they never start. Default stays
   background (no focus-steal) for hosters that run fine hidden. **v1.1.3:** an opt-in
   `frame:true` loads the embed inside an `<iframe>` on the companion's own `src/resolve.html`
   wrapper page instead of navigating the tab straight to it — some players (Vidking) are
   built to run framed and self-destruct (close/redirect) the instant they're the top-level
   window; framing gives them the context they expect, and the tab-scoped `webRequest` still
   captures the framed player's `.m3u8` from the subframe. Reserve these for hosters with no
   static path (it spins a real tab).

It still holds **no secrets**, signs nothing, and knows nothing source-specific — the
page (`crimson-sources`) drives all three primitives and decides when to use each.
`resolveInPage` is feature-detected (older companions lack it).

Everything is gated behind the user-toggled `enabled` flag. While **off**, the
extension answers handshakes (so the page knows it exists) but refuses all work
and holds zero rules.

## Why an extension (vs. the cors-proxy)

A plain browser `fetch()` can't (a) read most cross-origin responses (CORS) or
(b) set `Referer`/`Origin`/`User-Agent`/`Sec-Fetch-*`. The `crimson-proxy` edge
relay solves both — but it's a datacenter IP with a non-Chrome TLS fingerprint,
so it can't clear Cloudflare's JA3 checks and gets the *wrong* IP for ASN-bound
tokens. The extension solves all of it from a **real browser on the
viewer's residential IP**:

| Constraint | cors-proxy | **extension** |
| --- | --- | --- |
| CORS (read cross-origin) | ✅ relay | ✅ host access |
| Forbidden headers | ✅ inject | ✅ DNR rewrite |
| Cloudflare JA3 / TLS | ❌ not Chrome | ✅ real Chrome |
| ASN-bound tokens | ❌ datacenter IP | ✅ viewer's IP |
| Bytes off the backend | ✅ via edge | ✅ **direct CDN→viewer** |

See `../crimson-backend/New_System.md` §3–§4 for the full constraint analysis.

## Install (unpacked, dev)

1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select this folder (`crimson-extension/`).
3. Open Crimson Haven, click the toolbar sigil, press **Use Extension**.

No build step — it's plain JS/CSS/JSON. (Icons are pre-rendered in `icons/`;
regenerate with `scripts/` if you ever restyle.)

## Page integration contract (for `crimson-sources`)

The content script injects a MAIN-world API. Detection needs **no extension id**:

```js
// after page load:
if (window.CrimsonExtension?.available) { /* companion present */ }

// or for very early code (set before any page script runs):
document.documentElement.dataset.crimsonExt; // = version string, or undefined
window.addEventListener("crimson-extension-ready", (e) => { /* e.detail.version */ });
```

### API surface

```ts
window.CrimsonExtension = {
  available: true,
  version: string,
  protocol: number,

  hello(): Promise<{ ok, protocol, version, enabled }>,   // handshake
  status(): Promise<boolean>,                              // enabled?
  get enabled(): boolean | null,                           // cached
  onChange(cb: (enabled: boolean) => void): () => void,    // live on/off

  // privileged cross-origin fetch with header injection
  fetch(url: string, opts?: {
    method?: string,
    headers?: Record<string, string>,   // incl. Referer/Origin/User-Agent/...
    body?: string,
    redirect?: "follow" | "manual" | "error",
    credentials?: "omit" | "include" | "same-origin",
    responseType?: "text" | "arraybuffer",
  }): Promise<{
    ok: true, status, statusText, url, redirected,
    headers: Record<string, string>,
    body: string,                       // text, or base64 when arraybuffer
    bodyEncoding: "text" | "base64",
  }>,

  // header+CORS rules for THIS tab's media fetches (hls.js/<video>)
  installMediaRules(rules: Array<{
    requestDomains?: string[],          // preferred target (host list)
    urlFilter?: string,                 // or a urlFilter substring
    requestHeaders?: Record<string,string>, // Referer/Origin/UA to inject
    cors?: boolean,                     // add ACAO:* etc (default true)
    resourceTypes?: string[],           // default media+xhr+subframe+image+other
  }>, opts?: { replace?: boolean }): Promise<{ ok, ruleIds: number[] }>,

  clearMediaRules(ruleIds?: number[]): Promise<boolean>, // omit ids => clear tab

  // hidden-tab capture (v1.0.4+, protocol 2; optional — feature-detect it)
  resolveInPage?(url: string, opts?: {
    timeoutMs?: number,
    mustInclude?: string[],             // substrings the captured URL must contain (skip ad media)
    active?: boolean,                   // open the tab FOCUSED (restored when done) — for SPA
                                        // players that only autoplay while visible (Vidking); default background
    frame?: boolean,                    // load the embed inside an iframe on the companion's wrapper
                                        // page instead of navigating to it — for players that self-destruct
                                        // unless framed (Vidking); default direct navigation
  }): Promise<{
    ok: boolean,
    url?: string, streamType?: "hls" | "mp4",
    headers?: { referer?: string, origin?: string, userAgent?: string },
    error?: string,
  }>,
};
```

> `resolveInPage` needs the `webRequest` permission to watch the tab's network and
> `scripting` to inject the play nudge (both declared in the manifest). It opens one
> background tab per call and tidies it (and any popups it spawned) when it
> resolves/times out.

### Typical flow (a gated HLS source)

```js
const ext = window.CrimsonExtension;
if (ext?.available && (await ext.hello()).enabled) {
  // 1) resolve: fetch the embed page with the Referer the host gates on
  const r = await ext.fetch(embedUrl, { headers: { Referer: hostOrigin + "/" } });
  const cdnPlaylistUrl = parseEmbed(r.body);        // crimson-sources logic

  // 2) playback: let hls.js hit the CDN directly; the extension fixes headers+CORS
  await ext.installMediaRules([{
    requestDomains: [cdnHost],
    requestHeaders: {
      Referer: hostOrigin + "/",
      "User-Agent": "Mozilla/5.0 …",
    },
    cors: true,
  }]);
  hls.loadSource(cdnPlaylistUrl);                    // streams CDN → viewer
}
// on source switch / unmount:
await ext.clearMediaRules();
```

When `window.CrimsonExtension` is absent or `enabled` is false, `crimson-sources`
falls back to the cors-proxy / backend path — the extension is a pure upgrade,
never a requirement.

## Architecture

```
 page (MAIN world)            content.js (ISOLATED)        background.js (SW)
 window.CrimsonExtension  ──▶  postMessage bridge     ──▶  • doFetch  (DNR-inject
   .fetch / .installMediaRules                              headers, read body)
   .clearMediaRules        ◀──  relay responses       ◀──  • media rules (DNR:
   .hello / .onChange                                       headers + CORS, per tab)
                                                           • enabled flag + popup
```

- `manifest.json` — MV3; `declarativeNetRequestWithHostAccess`; `<all_urls>` as an
  **optional** host permission (requested at runtime from the popup on enable, not
  demanded at install); content script on `crimsonhaven.to` (+ `localhost`/`127.0.0.1`).
- `src/protocol.js` — shared message constants (SW + content script).
- `src/background.js` — the privileged core (the only place that fetches /
  installs DNR rules). Gated on `enabled`.
- `src/content.js` — isolated-world bridge; injects the in-page API and relays.
- `src/inpage.js` — MAIN-world `window.CrimsonExtension`.
- `src/resolve.html` + `src/resolve.js` — the `resolveInPage({frame:true})` wrapper page
  that hosts the embed in an `<iframe>` (for players that only run framed).
- `src/popup.*` — the one red button + live stats.

### Implementation notes / gotchas

- **Forbidden headers** are injected with `declarativeNetRequest` session rules,
  not passed to `fetch()` (which would strip them). The `fetch` RPC scopes its
  rule to `tabIds:[-1]` (SW-initiated requests only) so it never touches the
  page's media traffic; media rules scope to the calling `tabId`.
- **Rule hygiene:** media rules are torn down on tab close, on a fresh top-level
  navigation, and on the page's next `hello()` — so nothing leaks across reloads.
- **Response CORS:** `installMediaRules({cors:true})` adds `ACAO:*` +
  `Access-Control-Expose-Headers:*` to responses so `hls.js` can read them.
- **No build/bundler** by design (keeps it auditable and trivial to side-load).
- **Chromium only** for now (MV3 + `world:MAIN` via DOM injection). A Firefox
  port is feasible later (`browser.*`, slightly different DNR limits).

## Security posture

- Content script + host access are scoped; the in-page API only exposes
  fetch/rule primitives, no extension internals.
- The companion starts **off on a fresh install**: its capabilities need the
  optional `<all_urls>` host permission, which the popup requests (via a user
  gesture) the first time you switch it on. Once granted it stays on across
  sessions; turning it off in the popup persists, and revoking the grant from
  `chrome://extensions` flips it off automatically.
- The extension holds **no secrets** and signs nothing — secret-bound sources
  stay on the backend (New_System §5/§6).
- It is *not* a general web accelerator: it only loads on Crimson origins, and
  while the SW will fetch any URL the page asks for, only Crimson pages can ask.

---

## 📜 License

Released under the **MIT License** — see [`LICENSE`](LICENSE). In short: take it,
fork it, remix it, build something lovely with it. ( ˶ ˆ ᗜ ˆ ˶ )

A tiny request from Lumi, heart-to-heart 🩸 — the MIT license only asks that you
keep the copyright notice, but I'd *so* appreciate it if you also left a little
link back to the original home, [`crimsonhaven-to`](https://github.com/crimsonhaven-to),
in anything you build on top of this. It's not a legal demand, just a kindness
between mortals and curators — it helps others find their way home to the source,
and it makes my little undead heart flutter. Thank you for being wonderful! ( ^ . ^ )
