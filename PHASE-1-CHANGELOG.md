# AthariTV Android App - Phase 1 Changelog

Scope: launcher icon, Android Back button, admin login autofill. Nothing else was touched
(backend, APIs, database, admin panel logic, authentication, website design, `capacitor.config.json`
and the remote website URL are all unchanged).

## 1. Android launcher icon

Source: `frontend/public/brand/athari-full.webp` (760x563, original logo - not the favicon).

- Regenerated all launcher PNGs for mdpi / hdpi / xhdpi / xxhdpi / xxxhdpi with Lanczos resampling:
  - `ic_launcher_foreground.png` - adaptive foreground, 108dp canvas (108 / 162 / 216 / 324 / 432 px)
  - `ic_launcher.png` - legacy icon for Android 7.0-7.1 (API 24-25), 48dp, rounded square
  - `ic_launcher_round.png` - legacy round icon, 48dp, circular
- Logo is centred using its real content bounding box, scaled uniformly (no distortion, no crop), and sized so
  its farthest pixel stays inside the 66dp adaptive-icon safe circle - it is never clipped by any launcher mask
  (circle, squircle, teardrop...).
- `values/ic_launcher_background.xml`: adaptive background colour `#FFFFFF` -> `#000000`, which is the logo's own
  background. Before, the old foreground showed as a black box on white.
- `mipmap-anydpi-v26/ic_launcher.xml` and `ic_launcher_round.xml` were already correct (foreground = mipmap PNG,
  background = colour) and are unchanged. `AndroidManifest.xml` already points at `@mipmap/ic_launcher` /
  `@mipmap/ic_launcher_round` and is unchanged.
- Not deleted (you asked me never to delete files): the default Capacitor vectors
  `drawable-v24/ic_launcher_foreground.xml` and `drawable/ic_launcher_background.xml`. Nothing references them any
  more, so they are harmless leftovers. Optional cleanup: `git rm` them.

## 2. Android Back button

`frontend/android/app/src/main/java/com/atharitv/app/MainActivity.java`

One `OnBackPressedCallback` registered once in `onCreate`, bound to the activity lifecycle (removed automatically,
so no duplicate listeners, no leaks; no Handler/postDelayed). It uses the AndroidX back dispatcher because the old
`onBackPressed()` is not called for apps targeting Android 16 (targetSdk 36).

| Where you are | Back does |
|---|---|
| Home `/` | First press: toast "Press back again to exit". Second press within 2 s: exits the app. |
| Any other page of the app, with history | Goes back one step (WebView history = React Router history). |
| Any other page of the app, no history (e.g. opened directly) | Goes to the parent page instead of closing: `/aqaid/x` -> `/aqaid` -> `/`; `/article/x` -> `/`; signed-out admin pages -> `/`. Done through the page's own History API, so React Router handles it (no reload). |
| A page outside the app's own site (e.g. a payment page) | Plain WebView back; never the parent logic. |

- No new npm dependency was needed (no `@capacitor/app`, no `package-lock.json` change). The default Capacitor
  `backButton` JS event is not used.
- `res/values/strings.xml`: added `press_back_again_to_exit`.
- Also in `MainActivity`: explicit `setImportantForAutofill(YES)` on the WebView (API 26+), see section 3.

## 3. Admin login and password autofill

`frontend/src/admin/pages/Login.jsx`

- The login is now a real `<form onSubmit>` with a real `<button type="submit">`. Before, the form swallowed
  submit and the button was `type="button"`, so Android Autofill / Google Password Manager could not see a form
  submission and the "save password" prompt could not be triggered.
- Username: `name="username"`, `type="text"`, `autoComplete="username"`, no auto-capitalise/correct/spellcheck.
- Password: `name="password"`, `autoComplete="current-password"`, no auto-capitalise/correct/spellcheck.
  The show/hide toggle is unchanged.
- Security behaviour preserved: only a trusted user action logs in (`isTrusted` check), autofill never logs in by
  itself (800 ms guard after the fields change), one request at a time. Nothing is written to localStorage /
  sessionStorage; the password stays in React state only. Same `login()` call, same session/cookie flow.
- Side effect (intended): pressing Enter in the password field now logs in, like a normal website.
- `AdminAccess.jsx` (register / reset) was not touched; it already uses `new-password`.

### Honest Android WebView limitations
- Autofill only works if the phone has an autofill service enabled (Settings > Passwords & autofill > Google).
- The WebView keys saved passwords to the website's domain (`atharitv-website.pages.dev`), so credentials already
  saved in Chrome for that site can be offered; whether the "Save password?" prompt appears is decided by Google
  Password Manager, not by the app. It is less reliable than in Chrome, and not guaranteed.
- This website login is a single-page app: after login the form is removed from the page without a full page
  load. Autofill services usually treat that as a successful submit, but some do not.
- Switching the password field between hidden/visible changes its input type and can make some autofill
  services forget the field. Keep it hidden when saving a new password.

## 4. Tests added

`frontend/tests/androidPhase1.test.mjs` (6 tests): icon sizes per density, adaptive-icon wiring, single back
callback / no Handler, no hard-coded URL, login form semantics and preserved protections.

## 5. Verification and what could NOT be verified

Done here: all 6 new tests pass; XML and JSON configs parse; the original 10 test files were run - 8 pass, 2 fail
(`sizeSlider.test.mjs` test 3, `undoAndColors.test.mjs` test 1). **Those 2 fail identically on your untouched
original ZIP**, so they are not caused by this work. `MainActivity.java` was compiled with the JDK against hand-written
stub classes for the Android/Capacitor APIs, and its path logic was unit-checked.

NOT done (no internet in the build sandbox, so `npm install` was impossible and there is no `node_modules`,
Android SDK or device):
- `npm run build` (Vite production build) was **not run**. `Login.jsx` was not syntax-checked by a JSX compiler.
- `npx cap sync android` and any Gradle build were **not run**; `MainActivity.java` has not been compiled against the
  real Android/Capacitor libraries. The stub signatures are from memory of the public APIs.
- Nothing was tested on a real phone: Back behaviour, autofill and the icon need a device check.

## 6. Deployment notes

- Icon and Back button are native: they appear only after a NEW APK is built (your GitHub Action builds one on
  every push to `main`).
- The app loads `https://atharitv-website.pages.dev`. The Login.jsx change is web code, so it takes effect in the
  app (and the website) only after Cloudflare Pages deploys it.
