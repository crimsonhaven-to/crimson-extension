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

It does exactly two things, both at the network layer:

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

It does **not** scrape, resolve, sign, hold secrets, or know anything about any
specific source. All of that stays in `crimson-sources` (page) and the backend.
The extension is a dumb, sharp tool; the page decides how to use it.

Everything is gated behind the user-toggled `enabled` flag. While **off**, the
extension answers handshakes (so the page knows it exists) but refuses all work
and holds zero rules.

## Why an extension (vs. the cors-proxy)

A plain browser `fetch()` can't (a) read most cross-origin responses (CORS) or
(b) set `Referer`/`Origin`/`User-Agent`/`Sec-Fetch-*`. The `crimson-proxy` edge
relay solves both — but it's a datacenter IP with a non-Chrome TLS fingerprint,
so it can't clear Cloudflare's JA3 checks and gets the *wrong* IP for ASN-bound
tokens (e.g. VOE). The extension solves all of it from a **real browser on the
viewer's residential IP**:

| Constraint | cors-proxy | **extension** |
| --- | --- | --- |
| CORS (read cross-origin) | ✅ relay | ✅ host access |
| Forbidden headers | ✅ inject | ✅ DNR rewrite |
| Cloudflare JA3 / TLS | ❌ not Chrome | ✅ real Chrome |
| ASN-bound tokens (VOE) | ❌ datacenter IP | ✅ viewer's IP |
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
};
```

### Typical flow (a gated HLS source, e.g. VOE)

```js
const ext = window.CrimsonExtension;
if (ext?.available && (await ext.hello()).enabled) {
  // 1) resolve: fetch the embed page with the Referer the host gates on
  const r = await ext.fetch(embedUrl, { headers: { Referer: "https://voe.sx/" } });
  const cdnPlaylistUrl = parseVoe(r.body);          // crimson-sources logic

  // 2) playback: let hls.js hit the CDN directly; the extension fixes headers+CORS
  await ext.installMediaRules([{
    requestDomains: ["cloudwindow-route.com"],
    requestHeaders: {
      Referer: "https://voe.sx/",
      "User-Agent": "Mozilla/5.0 (Linux; Android 11; K) … Chrome/124 Mobile",
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

- `manifest.json` — MV3; `declarativeNetRequestWithHostAccess` + `<all_urls>`
  host access; content script on `crimsonhaven.to` (+ `localhost`/`127.0.0.1`).
- `src/protocol.js` — shared message constants (SW + content script).
- `src/background.js` — the privileged core (the only place that fetches /
  installs DNR rules). Gated on `enabled`.
- `src/content.js` — isolated-world bridge; injects the in-page API and relays.
- `src/inpage.js` — MAIN-world `window.CrimsonExtension`.
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
- All work is **off by default** and user-toggled.
- The extension holds **no secrets** and signs nothing — secret-bound sources
  (Febbox/Jellyfin/OpenSubtitles/TMDB) stay on the backend (New_System §5/§6).
- It is *not* a general web accelerator: it only loads on Crimson origins, and
  while the SW will fetch any URL the page asks for, only Crimson pages can ask.
  (A future hardening step: restrict the `fetch` RPC to an allowlist of known
  source/CDN hosts shipped with `crimson-sources`.)
