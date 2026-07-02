# Chrome Web Store — CI publishing setup

`.github/workflows/publish.yml` uploads and publishes a new version whenever you
publish a **GitHub Release** with a tag like `v1.0.7`. The workflow reads the
version from the tag and writes it into `manifest.json` inside the ZIP, so you
never hand-edit the version. Do a successful **manual** first submission before
relying on this.

## One-time setup

### 1. Get your Extension ID
After the first manual upload, copy the extension's ID from the
[Developer Dashboard](https://chrome.google.com/webstore/devconsole)
(the long `abcd...` string in the item's URL).

### 2. Create API credentials
Follow Google's guide: <https://developer.chrome.com/docs/webstore/using-api>

1. In [Google Cloud Console](https://console.cloud.google.com/), create/select a
   project and **enable the "Chrome Web Store API"**.
2. Configure the OAuth consent screen (External; add yourself as a test user).
3. Create an **OAuth client ID** of type **Desktop app**. Note the
   **Client ID** and **Client Secret**.
4. Generate a **refresh token** once (locally):
   - Open this URL (replace `CLIENT_ID`), approve, copy the `code=` value:
     ```
     https://accounts.google.com/o/oauth2/auth?response_type=code&scope=https://www.googleapis.com/auth/chromewebstore&client_id=CLIENT_ID&redirect_uri=urn:ietf:wg:oauth:2.0:oob
     ```
   - Exchange it for a refresh token:
     ```
     curl "https://accounts.google.com/o/oauth2/token" \
       -d "client_id=CLIENT_ID" \
       -d "client_secret=CLIENT_SECRET" \
       -d "code=THE_CODE" \
       -d "grant_type=authorization_code" \
       -d "redirect_uri=urn:ietf:wg:oauth:2.0:oob"
     ```
   - Save the `refresh_token` from the JSON response.

### 3. Add GitHub repo secrets
Repo → **Settings → Secrets and variables → Actions → New repository secret**:

| Secret                  | Value                     |
| ----------------------- | ------------------------- |
| `CHROME_EXTENSION_ID`   | from step 1               |
| `CHROME_CLIENT_ID`      | OAuth client ID           |
| `CHROME_CLIENT_SECRET`  | OAuth client secret       |
| `CHROME_REFRESH_TOKEN`  | refresh token from step 2 |

## Releasing

```bash
git tag v1.0.7
git push origin v1.0.7
```
Then create a GitHub Release from that tag (or use `gh release create v1.0.7 --generate-notes`).
The workflow packages `manifest.json`, `src/`, and `icons/`, and publishes.

## Notes
- **Version must increase every release.** The tag drives it; the Store rejects
  re-uploads of an equal/lower version.
- The committed `manifest.json` in `main` may lag behind the latest tag — that's
  fine, the tag is the source of truth for published versions. Bump it in a
  normal commit too if you prefer them in sync.
- To upload a **draft** for manual review instead of auto-publishing, set
  `publish: false` in the workflow.
- Publishing may still land in Google's **review queue**; the API call succeeds
  but the version goes live only after review.
