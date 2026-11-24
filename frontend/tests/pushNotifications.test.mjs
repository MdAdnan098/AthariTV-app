// Phase 3 (push notifications) - everything that can be checked without a phone, a browser or a Firebase project:
// the decision logic (prompt timing, preferences, safe links, browser support) and source-level checks that the pieces
// are wired together and that no secret is in the project.
// Run: cd frontend && node --test tests/pushNotifications.test.mjs
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import * as S from "../src/lib/push/pushState.js";

const url = (rel) => new URL(`../${rel}`, import.meta.url);
const read = (rel) => readFileSync(url(rel), "utf8");
const memory = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), raw: m }; };
const DAY = 24 * 3600 * 1000;

test("preferences: everything on by default, only booleans for known switches are accepted", () => {
  assert.deepEqual(S.defaultPrefs(), { enabled: true, posts: true, courses: true, live: true, announcements: true });
  assert.deepEqual(S.normalizePrefs({ posts: false, bogus: false, live: "no", enabled: false }), { enabled: false, posts: false, courses: true, live: true, announcements: true });
  assert.deepEqual(S.normalizePrefs(null), S.defaultPrefs());
});

test("saved state survives reload; corrupt or missing storage gives a clean default; a full storage never throws", () => {
  const st = memory();
  assert.deepEqual(S.loadState(st), S.emptyState());
  S.saveState(st, { ...S.emptyState(), enabled: true, token: "t".repeat(50), prefs: { ...S.defaultPrefs(), live: false } });
  const back = S.loadState(st);
  assert.equal(back.enabled, true);
  assert.equal(back.prefs.live, false);
  st.setItem(S.STORAGE_KEY, "{not json");
  assert.deepEqual(S.loadState(st), S.emptyState());
  assert.doesNotThrow(() => S.saveState({ setItem() { throw new Error("quota"); } }, S.emptyState()));
  assert.equal(S.newInstallId().length, 32);
  assert.notEqual(S.newInstallId(), S.newInstallId());
});

test("visits: one per 30 minutes", () => {
  let s = S.emptyState();
  s = S.countVisit(s, 1_000_000);
  s = S.countVisit(s, 1_000_000 + 60_000);
  assert.equal(s.visits, 1, "reload a minute later is the same visit");
  s = S.countVisit(s, 1_000_000 + 31 * 60_000 + 60_000);
  assert.equal(s.visits, 2);
});

test("permission prompt: not on the first visit, not when blocked / already on, not in admin, not again for 14 days after 'Not now'", () => {
  const now = 10 * DAY;
  const ok = { permission: "default", serverEnabled: true, now, path: "/" };
  const returning = { ...S.emptyState(), visits: 2 };
  assert.equal(S.shouldPrompt(returning, ok), true);
  assert.equal(S.shouldPrompt({ ...returning, visits: 1 }, ok), false, "first visit");
  assert.equal(S.shouldPrompt(returning, { ...ok, permission: "denied" }), false, "blocked: never nag");
  assert.equal(S.shouldPrompt(returning, { ...ok, permission: "granted" }), false);
  assert.equal(S.shouldPrompt(returning, { ...ok, permission: "unsupported" }), false);
  assert.equal(S.shouldPrompt(returning, { ...ok, serverEnabled: false }), false);
  assert.equal(S.shouldPrompt({ ...returning, enabled: true }, ok), false);
  assert.equal(S.shouldPrompt(returning, { ...ok, path: "/admin/articles" }), false);
  assert.equal(S.shouldPrompt({ ...returning, dismissedAt: now - 3 * DAY }, ok), false, "dismissed 3 days ago");
  assert.equal(S.shouldPrompt({ ...returning, dismissedAt: now - 15 * DAY }, ok), true, "after the cool-down");
});

test("safeInternalPath: a notification can only open a page of this site", () => {
  assert.equal(S.safeInternalPath("/article/x"), "/article/x");
  assert.equal(S.safeInternalPath("/live"), "/live");
  for (const bad of ["https://evil.example", "//evil.example", "javascript:alert(1)", "article/x", "/admin", "/admin/articles", "/a\\b", "/a\nb", "", null, 5, `/${"a".repeat(600)}`]) assert.equal(S.safeInternalPath(bad), null, String(bad));
});

test("web push support: iOS only as an installed app; missing APIs = unsupported", () => {
  const base = { hasServiceWorker: true, hasPush: true, hasNotification: true, userAgent: "Mozilla/5.0 (Windows NT 10.0) Chrome/140", platform: "Win32", maxTouchPoints: 0, standalone: false };
  assert.equal(S.webPushSupport(base), "ok");
  assert.equal(S.webPushSupport({ ...base, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari", platform: "iPhone" }), "needs-install");
  assert.equal(S.webPushSupport({ ...base, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari", platform: "iPhone", standalone: true }), "ok");
  assert.equal(S.webPushSupport({ ...base, platform: "MacIntel", maxTouchPoints: 5, userAgent: "Mozilla/5.0 (Macintosh) Safari" }), "needs-install", "iPadOS pretends to be a Mac");
  assert.equal(S.webPushSupport({ ...base, hasPush: false }), "unsupported");
  assert.equal(S.webPushSupport({ ...base, hasNotification: false }), "unsupported");
});

test("banner text: plain text, cut to length, unsafe links dropped, empty messages ignored", () => {
  assert.deepEqual(S.bannerFrom({ title: "T", body: "B", link: "/live" }), { title: "T", body: "B", link: "/live" });
  assert.equal(S.bannerFrom({ title: "T", link: "https://evil.example" }).link, "");
  assert.equal(S.bannerFrom({ title: "x".repeat(500) }).title.length, 100);
  assert.equal(S.bannerFrom({}), null);
  assert.deepEqual(S.bannerFrom({ body: "only body" }), { title: "only body", body: "", link: "" });
});

/* --------------------------- the website service worker --------------------------- */
function loadServiceWorker() {
  const listeners = {};
  const shown = [];
  const opened = [];
  let bg = null;
  const self_ = {
    location: { href: "https://site.example/firebase-messaging-sw.js?apiKey=k&projectId=p&messagingSenderId=1&appId=a", origin: "https://site.example" },
    registration: { showNotification: (title, opts) => { shown.push({ title, opts }); return Promise.resolve(); } },
    clients: { matchAll: async () => self_.__windows, openWindow: async (u) => { opened.push(u); } },
    addEventListener: (type, fn) => { listeners[type] = fn; },
    __windows: [],
  };
  const firebase = { initializeApp() {}, messaging: () => ({ onBackgroundMessage: (fn) => { bg = fn; } }) };
  vm.runInNewContext(read("public/firebase-messaging-sw.js"), { self: self_, firebase, importScripts() {}, URL, console });
  return { self: self_, listeners, shown, opened, background: (payload) => bg(payload) };
}

test("service worker: shows ONE notification from a data message, only with the site's own link", async () => {
  const sw = loadServiceWorker();
  await sw.background({ data: { title: "Naya mazmoon", body: "Tap karein", link: "/article/abc", nid: "n1" } });
  assert.equal(sw.shown.length, 1);
  assert.equal(sw.shown[0].title, "Naya mazmoon");
  assert.equal(sw.shown[0].opts.tag, "n1");
  assert.equal(sw.shown[0].opts.data.link, "/article/abc");
  await sw.background({ data: { title: "x", link: "https://evil.example/phish" } });
  assert.equal(sw.shown[1].opts.data.link, "/", "foreign link replaced by the home page");
  await sw.background({ data: { title: "x", link: "/admin/articles" } });
  assert.equal(sw.shown[2].opts.data.link, "/");
});

test("service worker: tap opens / focuses the right page", async () => {
  const sw = loadServiceWorker();
  let closed = false;
  const click = (link) => sw.listeners.notificationclick({ notification: { close() { closed = true; }, data: { link } }, waitUntil: (p) => (sw.pending = p) });
  click("/courses/tajweed");
  await sw.pending;
  assert.equal(closed, true);
  assert.deepEqual(sw.opened, ["https://site.example/courses/tajweed"], "no window open -> a new one");
  const navigated = [];
  sw.self.__windows = [{ url: "https://site.example/", focus: async function focus() { return this; }, navigate: async (u) => navigated.push(u) }];
  click("/live");
  await sw.pending;
  assert.deepEqual(navigated, ["https://site.example/live"], "open window is focused and sent to the page");
  click("https://evil.example/x");
  await sw.pending;
  assert.equal(navigated.at(-1), "https://site.example/", "a tampered link falls back to home");
});

test("service worker without Firebase settings does nothing harmful", () => {
  const listeners = {};
  vm.runInNewContext(read("public/firebase-messaging-sw.js"), {
    self: { location: { href: "https://site.example/firebase-messaging-sw.js", origin: "https://site.example" }, addEventListener: (t, f) => { listeners[t] = f; } },
    firebase: { initializeApp() { throw new Error("must not initialise without settings"); } },
    importScripts() {}, URL,
  });
  assert.equal(typeof listeners.notificationclick, "function");
});

/* ------------------------------------ wiring ------------------------------------ */
test("PWA + headers: manifest is valid and linked; the worker file is never cached", () => {
  const manifest = JSON.parse(read("public/manifest.webmanifest"));
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.start_url, "/");
  for (const icon of manifest.icons) assert.ok(existsSync(url(`public${icon.src}`)), icon.src);
  assert.match(read("index.html"), /rel="manifest" href="\/manifest\.webmanifest"/);
  assert.match(read("public/_headers"), /\/firebase-messaging-sw\.js\s+Cache-Control: no-cache/);
});

test("dependencies + admin / user screens are wired in", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.ok(pkg.dependencies["@capacitor/push-notifications"]);
  assert.ok(pkg.dependencies.firebase);
  assert.match(read("src/App.jsx"), /<PushLoader \/>/);
  assert.match(read("src/app/router.jsx"), /path="notifications"/);
  assert.match(read("src/admin/AdminApp.jsx"), /path="notifications"/);
  assert.match(read("src/admin/AdminLayout.jsx"), /\/admin\/notifications/);
  assert.match(read("src/components/public/Footer.jsx"), /\/notifications/);
  const api = read("src/services/admin.js");
  for (const route of ["/api/admin/notifications", "/auto-settings", "/continue"]) assert.ok(api.includes(route), route);
});

test("Android: Phase 1 + 2 code is intact and Phase 3 is added (permission, channel, icon, tap link)", () => {
  const manifest = read("android/app/src/main/AndroidManifest.xml");
  assert.match(manifest, /android\.permission\.POST_NOTIFICATIONS/);
  assert.match(manifest, /android\.permission\.INTERNET/);
  assert.match(manifest, /default_notification_channel_id"\s+android:value="atharitv_default"/);
  assert.match(manifest, /default_notification_icon"\s+android:resource="@drawable\/ic_stat_notify"/);
  assert.match(manifest, /\$\{applicationId\}\.fileprovider/, "existing file provider still there");
  assert.ok(existsSync(url("android/app/src/main/res/drawable/ic_stat_notify.xml")));
  assert.ok(existsSync(url("android/app/src/main/res/values/notification_colors.xml")));
  const main = read("android/app/src/main/java/com/atharitv/app/MainActivity.java");
  assert.match(main, /createNotificationChannel\(\)/);
  assert.match(main, /"atharitv_default"/);
  assert.match(main, /captureNotificationLink\(getIntent\(\)\)/);
  assert.match(main, /addOnNewIntentListener/);
  assert.match(main, /handleBack\(\)/, "Phase 1 back handling still there");
  const plugin = read("android/app/src/main/java/com/atharitv/app/AthariAppPlugin.java");
  assert.match(plugin, /notifyListeners\("notificationLink", data, true\)/);
  assert.match(plugin, /openExternalUrl/, "Phase 2 method still there");
  assert.match(plugin, /getAppInfo/);
  assert.equal(read("android/app/build.gradle").includes('applicationId "com.atharitv.app"'), true, "package id unchanged");
  assert.match(read("capacitor.config.json"), /"appId":\s*"com\.atharitv\.app"/);
});

test("server and Android use the SAME channel id and the same 'link' data key", () => {
  const backend = readFileSync(new URL("../../backend/src/utils/push.js", import.meta.url), "utf8");
  assert.match(backend, /channel_id: "atharitv_default"/);
  assert.match(backend, /link: link \|\| "\/"/);
});

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (["node_modules", ".git", "dist", "build", ".gradle"].includes(name)) continue;
    const p = `${dir}/${name}`;
    statSync(p).isDirectory() ? walk(p, out) : out.push(p);
  }
  return out;
}

test("no Firebase Admin / service-account secret is anywhere in the project", () => {
  const root = new URL("../../", import.meta.url).pathname;
  const files = walk(root).filter((f) => !/\.(png|jpg|jpeg|webp|ico|woff2?|ttf|zip|jar|so|keystore|jks)$/i.test(f) && !f.endsWith("push.test.mjs") && !f.endsWith("pushNotifications.test.mjs"));
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    assert.ok(!/BEGIN (RSA )?PRIVATE KEY-----\s*[A-Za-z0-9+\/=]{40,}/.test(text), `private key in ${f}`);
    assert.ok(!/"type"\s*:\s*"service_account"/.test(text), `service account JSON in ${f}`);
    assert.ok(!/AIza[0-9A-Za-z_-]{35}/.test(text), `API key in ${f}`);
  }
  assert.ok(!existsSync(new URL("../android/app/google-services.json", import.meta.url)), "google-services.json is the owner's own file, not shipped");
});
