# Phase 3 – Complete Push Notification System

Scope: Phase 3 only. Phase 1 (launcher icon, Back button, admin autofill) and Phase 2 (app update system) are untouched. Package ID is still `com.atharitv.app`. No APK was built.

## What was built

One server (the existing Cloudflare Worker + MongoDB) sends real push notifications through **Firebase Cloud Messaging (HTTP v1)** to two kinds of devices independently:

| | Android app | Website |
|---|---|---|
| Token comes from | `@capacitor/push-notifications` | Firebase Web Messaging (`firebase` package) + `/firebase-messaging-sw.js` |
| Message type | FCM *notification* message (the phone's system tray shows it – works with the app **closed** or in the **background**) | FCM *data-only* message (service worker shows it once, handles the tap) |
| App/site open | In-page banner at the top | In-page banner at the top |
| Tap | Opens the exact page (`data.link`) | Opens/focuses the page (`data.link`) |

The **Admin Panel → Notifications** page controls both. Normal in-page messages are NOT used for background delivery – those are real OS notifications.

### Events (all sent by the server, only after the database write succeeded)
| Event | When | Link | Never twice because |
|---|---|---|---|
| New post | status changes draft → published | `/article/:slug` | key `post:<id>` |
| New course | course becomes public (created public, or draft → public) | `/courses/:slug` | key `course:<id>` |
| New live session | published while upcoming | `/live` | key `live-new:<id>` |
| Live session starting | published session goes live (admin edit, YouTube sync, or the scheduled check) | `/live` | key `live-start:<id>` |
| Announcement / custom | written in the dashboard | optional page of the site | optional per-form id (double click = 409) |

Not notified: drafts, edits of already-published items, unpublish → publish again, recordings (ended sessions), hidden/archived courses. Each automatic event has an on/off switch in the dashboard. `POST …/publish` accepts `{"notify": false}` to publish a post quietly.

> The site has no "announcements" content type, so announcements are the dashboard's custom notifications (category *Announcements*).

### User preferences
`/notifications` page (footer link "Notification settings"): master switch + 4 categories (posts, courses, live, announcements). Saved on the device and on the server; sending skips devices that switched a category off. Unrelated to the admin login. The OS/browser permission is respected: if blocked, the page explains how to re-enable it, and the device is removed from the server.

Permission is requested only after a tap on "Notification on karein" (a card shown from the visitor's **2nd visit**, after 8 s, never in `/admin`; "Abhi nahi" hides it for 14 days; a blocked permission is never asked again). On Android 13+ this triggers the system `POST_NOTIFICATIONS` dialog.

### Devices / subscriptions
Collection `push_devices`: `{platform, token, installId, prefs, createdAt, lastSeenAt}` – no name, e-mail, phone, IP or browser fingerprint. Multiple devices per person = multiple records. Token refresh: same `installId` + new token replaces the old record and keeps the preferences. Dead tokens (`UNREGISTERED`, invalid-token) are deleted automatically after a send. Tokens are never returned by any API. There are no public user accounts on this site, so there is no user↔device link (admin sessions are not linked to devices).

### Security
* Service account JSON = Worker **secret** `FIREBASE_SERVICE_ACCOUNT` only. Used server-side to sign an OAuth request; never logged/returned/in the ZIP/in frontend.
* `/api/admin/notifications*` are behind the existing admin router guard **and** a role check; anonymous/forged/deactivated sessions → 401 (tested).
* Public device endpoints validate every field, are rate-limited (60/10 min/IP per isolate), need the device's own token to change/remove its record, and answer unregister identically for unknown tokens.
* Notification links must be a page of this website (`/…` or full https URL on the site's origin; `//host`, `javascript:`, other hosts, `/admin` are rejected) – checked on the server, in the service worker, in the page and in the Android code.
* A wrong Firebase project/credentials stops the send after the first group and **deletes no tokens**.
* Offline devices: FCM keeps the message (TTL 2 days; 1 hour for "live starting") and delivers when the phone is online.

### Cloudflare free-plan note (important)
One FCM request is needed per device, and the free plan allows 50 outgoing requests per Worker invocation. So a send handles `PUSH_BATCH_SIZE` devices per request (default **40**) and the notification keeps a cursor. The dashboard continues automatically while the page is open ("Continue sending" button if it stops). For audiences larger than one chunk **from automatic events** (nobody has the dashboard open), enable the cron trigger below. On a paid plan set `PUSH_BATCH_SIZE` to e.g. `400`.

## Files
See `PHASE-3-FILES.txt` (generated list). Summary:
* **Backend (new):** `utils/push.js`, `services/push/{fcm.service,dispatcher,events}.js`, `services/db/push.service.js`, `controllers/push.controller.js`, `routes/{public.push,admin.notifications}.routes.js`, `tests/push.test.mjs`
* **Backend (changed):** `index.js` (routes + cron), `config/env.js`, controllers `article`, `course`, `liveSession` (one hook each), `services/youtube/youtube.service.js` (hook), `scripts/bootstrap-indexes.mjs`
* **Frontend (new):** `config/firebase.js`, `lib/push/{pushState,pushClient}.js`, `components/push/PushLoader.jsx`, `pages/public/NotificationSettings.jsx`, `admin/pages/Notifications.jsx`, `public/firebase-messaging-sw.js`, `public/manifest.webmanifest`, `tests/pushNotifications.test.mjs`
* **Frontend (changed):** `package.json`, `.env.example`, `index.html`, `public/_headers`, `App.jsx`, `app/router.jsx`, admin `AdminApp/AdminLayout`, `Footer.jsx`, `services/{public,admin}.js`, `lib/nativeApp.js` (adds `onNotificationLink`, existing API unchanged), `i18n/roman.js`, `components/ui/icons.jsx` (bell)
* **Android (new/changed):** `AndroidManifest.xml` (POST_NOTIFICATIONS, default channel/icon/colour), `MainActivity.java` (channel, tap link), `AthariAppPlugin.java` (tap link event), `res/drawable/ic_stat_notify.xml`, `res/values/notification_colors.xml`, `google-services.json.example`

## Step 0 – required before building (lock file)
I had no network, so `package.json` lists the two new packages (`@capacitor/push-notifications`, `firebase`) but **`package-lock.json` could not be updated**. GitHub Actions uses `npm ci`, which **fails** if they disagree. On your phone (Termux) or any PC:
```
cd ~/storage/shared/Projects/AthariTV-app/frontend
npm install
```
then commit the changed `package-lock.json` too (the git commands below include it). If you can't run npm, tell me and we'll use another way (e.g. a one-time workflow step).

## Firebase setup (one time)
1. https://console.firebase.google.com → **Add project** (e.g. "AthariTV") → continue (Analytics optional).
2. **Android app:** Project settings (gear) → *Your apps* → Android icon → package name **`com.atharitv.app`** → Register → download **`google-services.json`** → save as `frontend/android/app/google-services.json` (repo folder) and commit it (it contains public client settings, not admin secrets). Skip the "add SDK" steps – Capacitor does that.
3. **Web app:** same page → *Add app* → Web (`</>`) → nickname "AthariTV Website" (no hosting) → copy `apiKey`, `projectId`, `messagingSenderId`, `appId`.
4. **Cloud Messaging API (V1):** Project settings → *Cloud Messaging* tab → make sure "Firebase Cloud Messaging API (V1)" is **Enabled** (if not, use the 3-dot menu → open in Google Cloud → Enable).
5. **VAPID / Web Push:** same tab → *Web configuration* → **Generate key pair** → copy the *Key pair* (public key).
6. **Backend credential:** Project settings → *Service accounts* → **Generate new private key** → downloads a JSON. **Never commit or share it.**

### Cloudflare Pages (website build variables) – Settings → Environment variables (Production)
```
VITE_FIREBASE_API_KEY=<apiKey>
VITE_FIREBASE_PROJECT_ID=<projectId>
VITE_FIREBASE_MESSAGING_SENDER_ID=<messagingSenderId>
VITE_FIREBASE_APP_ID=<appId>
VITE_FIREBASE_VAPID_KEY=<web push key pair>
```
These are public by design. Redeploy the Pages project after saving. (The Android app loads the website, so it needs no extra web config; only `google-services.json`.)

### Cloudflare Worker `atharitvbackend` – secret
Dashboard → Workers → atharitvbackend → Settings → Variables and Secrets → **Add secret** (type *Secret*): name `FIREBASE_SERVICE_ACCOUNT`, value = the **entire contents** of the downloaded service-account JSON. (From a PC: `npx wrangler secret put FIREBASE_SERVICE_ACCOUNT`.) Optional variables: `PUSH_BATCH_SIZE` (default 40), `PUSH_SITE_ORIGIN` (only if different from `ALLOWED_ORIGIN`). Then redeploy the Worker (your normal GitHub-push deploy).
Create the indexes once (optional – they are also created automatically on first use): `cd backend && npm run bootstrap:indexes` with your MongoDB env.

### Optional cron (live "starting" at the scheduled time + finishing big sends)
`wrangler.toml` was **not** changed. To enable, add this at the **very END** of `backend/wrangler.toml` (a block inserted at the top once broke your build – keep it last):
```
[triggers]
crons = ["*/5 * * * *"]
```
It also runs the existing course cleanup and YouTube sync every 5 min (the YouTube part needs its own key). Without cron: live notifications still fire instantly when an admin sets a session live, when YouTube sync detects it, or when published as live – only the "start time arrived by itself" case needs cron.

## Browser limits (be honest with users)
* **iPhone/iPad:** website push works only on iOS/iPadOS **16.4+** and only after *Share → Add to Home Screen* and opening from that icon (that is why a web manifest was added). In normal Safari tabs it is impossible; the settings page tells the visitor so. The Android app is unaffected.
* Chrome/Edge/Firefox/Opera/Samsung Internet (desktop + Android) and Safari 16+ on macOS work; private/incognito windows, blocked-notification browsers and some in-app browsers don't.
* Delivery to a closed browser depends on the OS (battery savers, "Do not disturb", the browser being force-stopped).
* The website's push is not used inside the Android app (it uses native push), so nobody gets two.
* The new manifest lets Chrome offer "Add to Home screen"; it is harmless and can be removed (delete the `<link rel="manifest">`) if unwanted.

## Testing report (honest)
**Run here (automated, all green):**
* Backend `node --test tests/*.test.mjs`: 166 tests, 165 pass – the 1 failure (“a short query matches a longer title…”) fails identically on your original ZIP (pre-existing, unrelated). **28 new push tests** cover: link/field validation, FCM payload shape (Android vs web), service-account JWT signature (RS256, verified), error classification (dead token vs outage vs wrong project), device registration/token refresh/preferences/unregister, rate limit, admin authorization (anonymous, forged, wrong-secret, deactivated → 401), no token/credential in responses, sending to the right platforms and only to devices allowing the category, dead-token cleanup, retry, config failure keeps tokens, duplicate prevention (double click, unpublish/publish again, re-edit), chunked sending + concurrent continue (no double delivery), publish never failing because of push, every automatic event (post, course, live new, live starting, cron sweep), history.
* Frontend `node --test tests/*.test.mjs`: 105 tests, 103 pass – 2 failures (“H3/H2 label positions…”, “highlight text colour…”) fail identically on the original ZIP. **15 new tests**: prompt timing, preferences, safe links, iOS support detection, banner text, the real service-worker file executed in a sandbox (shows one notification, safe links, tap opens/focuses), manifest/headers, wiring, Phase 1/2 Android code intact, and "no secret in the project".
* All of this used an in-memory MongoDB stand-in and a **fake FCM server**.

**NOT verified – needs you (I could not do these here):**
* **Real push delivery** (Android closed/background/foreground, website) – needs your Firebase project, secret, `google-services.json` and a physical phone. Not claimed as working until you test.
* **Production frontend build (`vite build`)** – no network ⇒ no `npm install`, so Vite/React/the new packages were not available. The new `.jsx` files were reviewed by hand, **not compiled**. The first CI/Cloudflare build is the real check; send me any error.
* **Android compile** – the Java edits were reviewed but not compiled (no Android SDK/javac). `npx cap sync android` (CI does it) pulls the push plugin natively.
* Cold-start tap deep link on a real phone (uses the launch intent + a retained plugin event; the plugin's own `pushNotificationActionPerformed` is a second route).
* Foreground banner on a real device; Android 13+ permission dialog; token refresh in the field.

## Test plan on your phone (after setup)
1. Install the new APK, open it twice, tap *Notification on karein* → allow. Admin → Notifications should show 1 Android device.
2. Send a custom notification with link `/live`: (a) app open → banner at top; (b) Home button → status bar; (c) swipe the app away → status bar; tap each → opens `/live`.
3. Publish a post from the admin → notification → tap opens that post. Edit it → no new notification.
4. Browser: open the site twice, allow → Web count 1; repeat (a)-(c) with the tab closed.
5. `/notifications`: switch "Naye courses" off → send a Courses test → not received.
