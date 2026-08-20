# TaskFlow — Chrome extension

See and update the same TaskFlow tasks the web app shows, from the browser
toolbar. It reads and writes the **same Firestore collections** (`tasks`,
`teams`, `users`) over the REST API with a Firebase ID token, so
`firestore.rules` applies unchanged and edits appear live in the web app.

No build step, no bundler — plain ES modules, same as `public/`.

## What it does

**See**
- Your team's tasks grouped by status, sorted by priority then due date
- Filter by **Mine** / **All** / **Due & late**, plus free-text search over
  title, description, labels and assignee
- Toolbar badge with the number of your open tasks due today or overdue
  (orange), turning red once something is actually late
- Team switcher (Personal + the team you belong to), light/dark theme

**Update**
- One-click done / reopen straight from the list
- Per-field editing in the detail pane — title, description, status, priority,
  assignee, due date — each saved as it changes
- Add and remove labels, add/tick/remove subtasks, post comments
- Create a task, delete a task

Every edit is optimistic: the local cache and UI update first, the PATCH follows,
and a failed write pulls the server's version back.

## Install

1. Open `chrome://extensions`, turn on **Developer mode**
2. **Load unpacked** → select this `extension/` folder
3. The extension ID is pinned by the `key` field in `manifest.json`, so it is
   always:

   ```
   ijplblgndpgkpbgpabcfffnomakcplah
   ```

   which makes the OAuth redirect URI:

   ```
   https://ijplblgndpgkpbgpabcfffnomakcplah.chromiumapp.org/
   ```

4. Do the Google sign-in setup below, then click the toolbar icon and sign in.

## Google sign-in setup (one time) — done

Sign-in goes: `chrome.identity.getAuthToken` → Google access token → Firebase
Identity Toolkit → Firebase session.

The extension uses a **Chrome extension** OAuth client created inside the same
GCP project as Firebase (`taskflow-be186` / `411677321604`), which means:

- Firebase trusts the token, because the client lives in its own project
- There is **no redirect URI to register** — Chrome brokers the token itself

The client id lives in two places that must stay identical:
`manifest.json` → `oauth2.client_id`, and `config.js` → `googleClientId`.
Its **Item ID** in Google Cloud Console must be the extension id below.

If you ever swap in a plain *Web application* client instead, the extension
falls back automatically to `launchWebAuthFlow`, and you then do need
`https://ijplblgndpgkpbgpabcfffnomakcplah.chromiumapp.org/`
in that client's authorised redirect URIs — plus, if the client is in a
different GCP project, whitelisting under Firebase Console → Authentication →
Sign-in method → Google.

Either way the sign-in tab prints the exact fix when something is off.

## Files

| File | What it is |
|---|---|
| `manifest.json` | MV3 manifest; `key` pins the extension id |
| `config.js` | Firebase + OAuth values (gitignored, generated from `public/config.js`) |
| `config.example.js` | Template with setup notes |
| `lib/auth.js` | `getAuthToken` → Firebase session, silent token refresh, web-client fallback |
| `lib/firestore.js` | Firestore REST client + the JS ⇄ Firestore value codec |
| `lib/store.js` | `chrome.storage` cache, sync, badge |
| `lib/model.js` | Statuses, priorities, colours, date wording — mirrors `public/app.js` |
| `lib/icons.js` | Inline Lucide paths (extension pages can't load a CDN) |
| `popup.html/.js/.css` | The popup |
| `signin.html/.js` | Sign-in tab (see below) |
| `background.js` | Service worker: 10-minute sync alarm + badge |
| `key.pem` | Private key matching `manifest.json`'s `key` (gitignored; only needed to pack a `.crx` with the same id) |

## Notes

- **Why sign-in runs in a tab, not the popup.**
  The Google account prompt opens its own window, which closes the
  browser-action popup and destroys its JS context. `signin.html` runs the flow
  in a real tab instead, then closes itself.
- **Session lifetime.** The Google OAuth step happens once. After that the
  Firebase refresh token in `chrome.storage.local` renews the ID token, so you
  stay signed in until you sign out.
- **Domain restriction.** Mirrors the web app: only `@fairdee.co.th` accounts.
  Change `allowedDomain` in `config.js` (`""` allows any Google account).
- **Task shape.** Created tasks carry exactly the fields `saveTask()` writes in
  `public/app.js` (including `teamId`, `ownerUid`, `createdBy`), and the doc id
  matches the app's `uid()` scheme, so the web app treats them as its own.
- **Publishing to the Web Store.** Remove the `key` field from `manifest.json`
  first — the store assigns its own id, which changes the redirect URI.

## Keyboard

| Key | Action |
|---|---|
| `Alt+Shift+T` | Open the popup |
| `/` | Focus search |
| `Esc` | Close the detail pane |
