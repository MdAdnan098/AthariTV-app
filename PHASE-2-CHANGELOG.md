# AthariTV Android App - Phase 2 Changelog: App Update System

Scope: tell users of the **Android app** when a newer **APK** exists, and let the admin manage that.
Phase 1 (icon, Back button, login autofill) is kept as it was. The package id, the remote website URL
(`capacitor.config.json`), the existing APIs, database collections, login/session system and website design are unchanged.

## 0. The one rule: website version is NOT app version

AthariTV loads the website remotely inside the app. So:

- Website / frontend / backend / database changes reach the app by themselves after deployment. **No new APK, no update dialog.**
- A new APK (and an entry in Admin -> App Updates) is needed only for native changes: icon, Back handling, new native plugin,
  package changes, Capacitor / Android upgrades.
- The "version" in this system is the **installed Android app's `versionName`** (`android/app/build.gradle`), read natively.
  There is no website version anywhere in this feature.

## 1. How it works

| Part | What it does |
|---|---|
| Backend | One MongoDB document (`app_releases`, `_id: "android"`) holds: latest version, minimum supported version, release date, release notes, APK URL, optional store URL, mandatory flag, published flag. Public read endpoint + admin-only write endpoint. |
| Native (Android) | New local Capacitor plugin `AthariApp`: `getAppInfo()` (real installed versionName / versionCode / package) and `openExternalUrl({url})` (https only). Registered in `MainActivity`. No npm package, no new permission. |
| Website code (runs inside the app) | `AppUpdateLoader` mounts only when running inside the Android app (lazy chunk, never loaded in a normal browser). `AppUpdateGate` reads the installed version, fetches the release, decides, shows the dialog. |
| Admin | New page **Admin -> App Updates** to set versions, notes, URLs, mandatory flag, and publish / unpublish. |

### Version rules
- Format: 1-4 numeric parts, e.g. `1`, `1.2`, `1.2.3`, `1.2.3.4`. Compared numerically (`1.10` > `1.9`, `1.0` = `1.0.0`).
- Installed `versionName` such as `1.2.0-debug` is read as `1.2.0`.
- Update available: latest > installed.
- **Mandatory** when latest > installed AND (admin ticked "Mandatory" OR installed < minimum supported version).
- Minimum supported version cannot be higher than the latest version (validated).
- A mandatory update with no safe URL is never enforced (no trap).

### Startup check (`AppUpdateGate`)
- Runs at app start, and again when the app returns to the foreground (at most every 6 hours). One check at a time, one dialog at a time.
- Optional update: "Later" hides **that version** for 3 days; a newer version shows immediately. "Update now" hides it for the rest of the session.
- Mandatory update: no "Later", no close. After "Update now" it shows an install hint and a "Dobara check karein" button that re-reads the installed version and re-checks the server (so an admin unpublishing releases a blocked user).
- Offline / server error / broken response: the check is skipped quietly and the app works normally. Only exception: a mandatory update that was already announced stays enforced from the saved copy until the app is updated or the server says otherwise.
- Only public release data and the "Later" choice are kept in localStorage (`fs_app_update`). No secrets, no tokens.

### Dialog
AthariTV logo + wordmark, new version, your version, release date, "What's new" list, **Abhi update karein**, **Baad mein** (optional only). Uses the site's own classes (`bg-paper`, `border-rule`, `btn-primary btn-cta`, `btn-outline`) and the Roman UI text dictionary (`i18n/roman.js`, new `appUpdate` section). Release notes are rendered as plain text (never HTML).

### Download / install flow (decision)
"Update now" opens the **official https link** (store URL if set, otherwise the APK URL) in the phone's browser. Android's own download and "install this app?" screens do the rest, so the user always approves the install.

I did **not** build in-app silent / direct installation (FileProvider + `REQUEST_INSTALL_PACKAGES` + our own downloader) because: Android never allows silent installs; the permission is restricted on Google Play (it can get a Play listing rejected); and it cannot be compiled against the real SDK or tested on a device in this environment. It can be added later as its own phase after real-device testing.

## 2. Admin (secure)
- `GET /api/admin/app-release` and `PUT /api/admin/app-release`. Every `/api/admin/*` path is already authenticated by the router guard in `backend/src/index.js` (anonymous / forged / deactivated-admin requests get 401); the controller also calls `requireAdmin`.
- Validation on the server: versions, min <= latest, real YYYY-MM-DD date, notes (max 20 lines x 300 chars), URLs https-only with no credentials, no IP / localhost / single-label hosts, <= 2048 chars. Publishing requires at least one URL. Optional host allow-list (below).
- The public endpoint `GET /api/public/app-update` returns nothing when unpublished, and never returns who saved it or when. It is sent with `Cache-Control: no-cache` and is not in the Pages proxy's edge-cache list, so publish / unpublish takes effect at once.
- The admin page has a confirmation before publishing a mandatory update.

## 3. Files

### New (14)
- `backend/src/utils/appRelease.js` - version + URL + input validation
- `backend/src/services/db/appRelease.service.js` - `app_releases` access
- `backend/src/controllers/appRelease.controller.js`
- `backend/src/routes/public.appRelease.routes.js`
- `backend/src/routes/admin.appRelease.routes.js`
- `backend/tests/appRelease.test.mjs`
- `frontend/android/app/src/main/java/com/atharitv/app/AthariAppPlugin.java`
- `frontend/src/lib/appUpdate.js` - comparison, evaluation, snooze, the whole check
- `frontend/src/lib/nativeApp.js` - bridge to the plugin
- `frontend/src/components/app/AppUpdateLoader.jsx`
- `frontend/src/components/app/AppUpdateGate.jsx` - check + dialog
- `frontend/src/admin/pages/AppRelease.jsx`
- `frontend/tests/appUpdate.test.mjs`
- `PHASE-2-CHANGELOG.md`

### Modified (9)
- `backend/src/index.js` - registers the two new route files
- `backend/src/config/env.js` - optional `APP_UPDATE_ALLOWED_HOSTS`
- `frontend/android/app/src/main/java/com/atharitv/app/MainActivity.java` - `registerPlugin(AthariAppPlugin.class)` (Phase 1 Back-button code kept as is)
- `frontend/src/App.jsx` - mounts `<AppUpdateLoader />`
- `frontend/src/services/public.js` - `publicApi.appUpdate`
- `frontend/src/services/admin.js` - `adminApi.appRelease`
- `frontend/src/admin/AdminApp.jsx` - route `/admin/app-update`
- `frontend/src/admin/AdminLayout.jsx` - sidebar entry "App Updates"
- `frontend/src/i18n/roman.js` - `appUpdate` texts

(The Android manifest, `build.gradle`, `capacitor.config.json`, `wrangler.toml`, the Pages `functions/` proxy and `package.json` / lock files are untouched.)

## 4. Backend deployment / configuration

1. **Deploy the backend Worker** the same way you always do (e.g. `cd backend && npm run deploy`, or your Cloudflare Git integration). Deploy it **before** the website so the new endpoints exist.
2. No new secrets, no new bindings, no database migration, no index script: the `app_releases` collection is created automatically the first time an admin saves.
3. Optional hardening: add a plain-text variable `APP_UPDATE_ALLOWED_HOSTS` (e.g. `github.com,play.google.com,atharitv-website.pages.dev`) in the Worker's dashboard settings. Then APK / store URLs must be on those hosts (or subdomains). Empty = any public https host. (Use the dashboard: `keep_vars = true` keeps it across deploys.)
4. The website deploys as usual (push to GitHub -> Cloudflare Pages).
5. The native part (plugin) only exists in a **new APK**. Installed Phase-1 / older APKs do not have the `AthariApp` plugin, so they quietly show no update dialog. Install the next APK (built after all phases) once by hand; from then on updates are announced.

### How to release a future APK
1. Bump `versionCode` (+1) and `versionName` (e.g. `1.1.0`) in `frontend/android/app/build.gradle`. (Today: `versionCode 1`, `versionName "1.0"`.)
2. Build the APK, host it at an https link you control.
3. Admin -> App Updates: Latest version = the same `versionName`, notes, date, APK URL -> **Publish update**.
4. Use "Minimum supported version" / "Mandatory" only when old apps genuinely can no longer work.

### IMPORTANT before the first real update (signing)
Android only installs an update over an installed app if both APKs are signed with the **same key**. Your GitHub Action builds `assembleDebug` with no signing config in the project, and no keystore file is in the repo. A fresh CI runner creates a new debug key each time, so consecutive CI APKs are normally **not installable over each other** ("App not installed"). Before relying on this system, build with one fixed keystore (kept in GitHub Secrets). Not done here (it needs the workflow and secrets, and you asked me not to build the APK); recommended as the next step.

## 5. Tests and honest limitations

Run in this environment:
- `frontend/tests/appUpdate.test.mjs`: 19 tests pass - version comparison, optional / mandatory (flag and below-minimum) / no update, no-safe-URL, "Later" snoozing (3 days, newer version shows), backend failure and bad JSON, offline (optional skipped, mandatory kept, no loop after updating, unpublish releases), broken storage, safe notes, native-only mounting, admin route inside `<Protected>`, no install permission, package id + remote URL untouched.
- `backend/tests/appRelease.test.mjs`: 9 tests pass - rules, URL validation, public endpoint hides unpublished and admin info, **admin authorization (401 for anonymous / forged / deactivated)**, save + read back, invalid input writes nothing, allow-list, DB failure gives a generic 5xx with no secrets.
- Phase 1 tests: 6 pass. Existing backend suite: all pass except `folders.test.mjs` test 20 (fails the same on your original ZIP). Existing frontend: `sizeSlider` test 3 and `undoAndColors` test 1 fail the same on your original ZIP.
- esbuild bundle of the whole frontend resolves every import (the update code is a separate lazy chunk, not in the main entry); only an old duplicate-key warning in `FolderForm.jsx` appears, same as the original.
- `MainActivity.java` and `AthariAppPlugin.java` compile against hand-written Android/Capacitor stubs; the native URL check was unit-tested (16 cases).

NOT possible here (no internet, no Android SDK, no device) - please treat as unverified until you build:
- `npm run build` (Vite), `npx cap sync`, Gradle build: not run. Backend tests ran with a small stand-in for the `mongodb` package (not shipped), not a real database.
- On a device: that `window.Capacitor` / the `AthariApp` plugin work for the remote website URL, the dialog look, and the open-link flow.

Known limits:
- Android's Back button does not close the update dialog (it follows the normal Back rules underneath); use "Baad mein".
- "Mandatory" is enforced by the app itself. It is a policy tool, not a security boundary (a modified app or an offline first run can skip it).
- Notes and URLs come from the admin only; the app never downloads or installs anything by itself.
