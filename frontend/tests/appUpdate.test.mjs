// Phase 2 (Android app update system): version comparison, optional / mandatory / no-update scenarios,
// backend-failure and offline scenarios, "Later" snoozing, and source-level safety checks.
// Run: cd frontend && node --test tests/appUpdate.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  compareVersions, evaluateRelease, isSafeDownloadUrl, isSnoozed, isValidVersion, normalizeInstalledVersion,
  pickUpdateUrl, runUpdateCheck, sanitizeRelease, snoozeVersion, SNOOZE_MS, STORAGE_KEY,
} from "../src/lib/appUpdate.js";

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const memoryStorage = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), _m: m }; };
const release = (over = {}) => ({
  latestVersion: "1.2.0", minSupportedVersion: null, releaseDate: "2026-11-22", releaseNotes: ["Fix A", "Fix B"],
  downloadUrl: "https://downloads.example.com/athari.apk", storeUrl: "", mandatory: false, ...over,
});
const ok = (r) => async () => r;
const failing = (err = new Error("network")) => async () => { throw err; };
const NOW = 1_800_000_000_000;

/* ------------------------------- versions ------------------------------- */
test("version comparison: numeric (1.10 > 1.9), 1.0 == 1.0.0, invalid -> null", () => {
  assert.equal(compareVersions("1.10", "1.9"), 1);
  assert.equal(compareVersions("1.0", "1.0.0"), 0);
  assert.equal(compareVersions("1.0.1", "1.0.0"), 1);
  assert.equal(compareVersions("2.0", "10.0"), -1);
  assert.equal(compareVersions("1.2.3.4", "1.2.3"), 1);
  assert.equal(compareVersions("abc", "1.0"), null);
  assert.equal(compareVersions("1.0", ""), null);
  assert.equal(isValidVersion("1.2.3.4.5"), false);
  assert.equal(isValidVersion("v1.0"), false);
});

test("installed native versionName is normalised (debug / beta suffixes, leading v)", () => {
  assert.equal(normalizeInstalledVersion("1.2.0"), "1.2.0");
  assert.equal(normalizeInstalledVersion("1.2.0-debug"), "1.2.0");
  assert.equal(normalizeInstalledVersion("v1.2"), "1.2");
  assert.equal(normalizeInstalledVersion(" 3 "), "3");
  assert.equal(normalizeInstalledVersion("beta"), null);
  assert.equal(normalizeInstalledVersion(undefined), null);
});

test("download URLs: https only, public host, no credentials; store URL wins over APK URL", () => {
  assert.equal(isSafeDownloadUrl("https://downloads.example.com/a.apk"), true);
  for (const bad of ["http://example.com/a.apk", "https://u:p@example.com/", "https://10.0.0.1/a", "https://localhost/a", "https://[::1]/a", "javascript:alert(1)", "", null, undefined, 5]) assert.equal(isSafeDownloadUrl(bad), false, String(bad));
  assert.equal(pickUpdateUrl(release({ storeUrl: "https://play.google.com/store/apps/details?id=x" })), "https://play.google.com/store/apps/details?id=x");
  assert.equal(pickUpdateUrl(release({ storeUrl: "http://bad.example.com" })), "https://downloads.example.com/athari.apk");
  assert.equal(pickUpdateUrl(release({ storeUrl: "", downloadUrl: "" })), null);
});

/* --------------------------- scenarios (evaluate) --------------------------- */
test("OPTIONAL update: newer version, not mandatory, installed >= minimum", () => {
  assert.equal(evaluateRelease(release(), "1.0.0").status, "optional");
  assert.equal(evaluateRelease(release({ minSupportedVersion: "1.0" }), "1.0.5").status, "optional");
});

test("MANDATORY update: marked mandatory, OR installed version is below the minimum supported version", () => {
  assert.deepEqual(evaluateRelease(release({ mandatory: true }), "1.1.0"), { status: "mandatory", reason: "marked-mandatory" });
  assert.deepEqual(evaluateRelease(release({ minSupportedVersion: "1.1" }), "1.0.9"), { status: "mandatory", reason: "below-minimum" });
  assert.equal(evaluateRelease(release({ minSupportedVersion: "1.1" }), "1.1.0").status, "optional"); // exactly the minimum is still supported
});

test("NO update: up to date, newer than published, nothing published, bad data", () => {
  assert.equal(evaluateRelease(release(), "1.2.0").status, "none");
  assert.equal(evaluateRelease(release({ mandatory: true }), "1.2.0").status, "none"); // mandatory never applies to an up-to-date app
  assert.equal(evaluateRelease(release(), "1.3").status, "none");
  assert.equal(evaluateRelease(null, "1.0").status, "none");
  assert.equal(evaluateRelease(release({ latestVersion: "x" }), "1.0").status, "none");
});

test("never trapped: a mandatory update with no safe URL is NOT enforced", () => {
  assert.equal(evaluateRelease(release({ mandatory: true, downloadUrl: "", storeUrl: "" }), "1.0").status, "none");
  assert.equal(evaluateRelease(release({ mandatory: true, downloadUrl: "http://insecure.example.com/a.apk" }), "1.0").status, "none");
});

/* ------------------------------ runUpdateCheck ------------------------------ */
test("check: optional update is returned with release data and the installed version", async () => {
  const r = await runUpdateCheck({ installedVersionName: "1.0", fetchRelease: ok(release()), storage: memoryStorage(), now: NOW });
  assert.equal(r.status, "optional");
  assert.equal(r.installed, "1.0");
  assert.equal(r.release.latestVersion, "1.2.0");
  assert.deepEqual(r.release.releaseNotes, ["Fix A", "Fix B"]);
});

test("check: mandatory update is not snoozable", async () => {
  const storage = memoryStorage();
  snoozeVersion(storage, "1.2.0", NOW);
  const r = await runUpdateCheck({ installedVersionName: "1.0", fetchRelease: ok(release({ mandatory: true })), storage, now: NOW + 1000 });
  assert.equal(r.status, "mandatory");
});

test("check: no update available", async () => {
  assert.equal((await runUpdateCheck({ installedVersionName: "1.2.0", fetchRelease: ok(release()), storage: memoryStorage() })).status, "none");
  assert.equal((await runUpdateCheck({ installedVersionName: "1.0", fetchRelease: ok(null), storage: memoryStorage() })).status, "none"); // unpublished
});

test("check: 'Later' hides the same version for 3 days, a NEWER version shows immediately", async () => {
  const storage = memoryStorage();
  snoozeVersion(storage, "1.2.0", NOW);
  const same = (t) => runUpdateCheck({ installedVersionName: "1.0", fetchRelease: ok(release()), storage, now: t });
  assert.equal((await same(NOW + 1000)).reason, "snoozed");
  assert.equal((await same(NOW + SNOOZE_MS - 1000)).status, "none");
  assert.equal((await same(NOW + SNOOZE_MS + 1000)).status, "optional"); // snooze expired
  const newer = await runUpdateCheck({ installedVersionName: "1.0", fetchRelease: ok(release({ latestVersion: "1.3.0" })), storage, now: NOW + 1000 });
  assert.equal(newer.status, "optional");
  assert.equal(isSnoozed(storage, "1.2.0", NOW - 1), false); // a clock set back never hides it forever
});

test("BACKEND FAILURE (500 / bad JSON / thrown error), nothing saved: the check is skipped quietly, the app is not blocked", async () => {
  for (const fetchRelease of [failing(Object.assign(new Error("Request failed (500)"), { status: 500 })), ok({ weird: true }), ok("html page"), ok([1, 2])]) {
    const r = await runUpdateCheck({ installedVersionName: "1.0", fetchRelease, storage: memoryStorage() });
    assert.equal(r.status, "none");
    assert.equal(r.reason, "check-failed");
  }
});

test("OFFLINE: optional updates are not re-shown from the saved copy, but an already-announced MANDATORY update stays enforced", async () => {
  const optional = memoryStorage();
  await runUpdateCheck({ installedVersionName: "1.0", fetchRelease: ok(release()), storage: optional, now: NOW });
  const offlineOptional = await runUpdateCheck({ installedVersionName: "1.0", fetchRelease: failing(), storage: optional, now: NOW + 5000 });
  assert.equal(offlineOptional.status, "none");

  const mandatory = memoryStorage();
  await runUpdateCheck({ installedVersionName: "1.0", fetchRelease: ok(release({ mandatory: true })), storage: mandatory, now: NOW });
  const offlineMandatory = await runUpdateCheck({ installedVersionName: "1.0", fetchRelease: failing(), storage: mandatory, now: NOW + 5000 });
  assert.equal(offlineMandatory.status, "mandatory");
  assert.equal(offlineMandatory.source, "cache");
  // ...but once the app is updated, the same saved copy no longer applies: no endless loop
  const afterUpdate = await runUpdateCheck({ installedVersionName: "1.2.0", fetchRelease: failing(), storage: mandatory, now: NOW + 9000 });
  assert.equal(afterUpdate.status, "none");
});

test("unpublishing releases a blocked user: a successful check replaces the saved mandatory copy", async () => {
  const storage = memoryStorage();
  await runUpdateCheck({ installedVersionName: "1.0", fetchRelease: ok(release({ mandatory: true })), storage, now: NOW });
  assert.equal((await runUpdateCheck({ installedVersionName: "1.0", fetchRelease: ok(null), storage, now: NOW + 1 })).status, "none");
  assert.equal((await runUpdateCheck({ installedVersionName: "1.0", fetchRelease: failing(), storage, now: NOW + 2 })).status, "none"); // nothing left to enforce
});

test("unknown installed version -> no dialog; broken / unavailable storage never throws", async () => {
  assert.equal((await runUpdateCheck({ installedVersionName: "", fetchRelease: ok(release()), storage: memoryStorage() })).status, "none");
  const broken = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); } };
  assert.equal((await runUpdateCheck({ installedVersionName: "1.0", fetchRelease: ok(release()), storage: broken })).status, "optional");
  assert.equal((await runUpdateCheck({ installedVersionName: "1.0", fetchRelease: ok(release()) })).status, "optional"); // no storage at all
  const garbage = memoryStorage(); garbage.setItem(STORAGE_KEY, "{not json");
  assert.equal((await runUpdateCheck({ installedVersionName: "1.0", fetchRelease: ok(release()), storage: garbage })).status, "optional");
});

test("sanitizeRelease: keeps notes as plain text, caps them, rejects malformed data", () => {
  const r = sanitizeRelease({ ...release(), releaseNotes: ["<img src=x onerror=alert(1)>", "", "x".repeat(500), ...Array(30).fill("n")] });
  assert.equal(r.releaseNotes[0], "<img src=x onerror=alert(1)>"); // stored as text; React escapes it when shown
  assert.equal(r.releaseNotes[1].length, 300);
  assert.equal(r.releaseNotes.length, 20);
  assert.equal(sanitizeRelease(null), null);
  assert.equal(sanitizeRelease({ ...release(), releaseDate: "yesterday" }).releaseDate, null);
  assert.throws(() => sanitizeRelease({ ...release(), latestVersion: "1.x" }));
  assert.throws(() => sanitizeRelease({ ...release(), minSupportedVersion: "nope" }));
});

/* ------------------------- wiring / safety (source checks) ------------------------- */
test("the update check only runs inside the Android app and shows no HTML from the server", () => {
  const loader = read("src/components/app/AppUpdateLoader.jsx");
  assert.match(loader, /isNativeApp\(\)/);
  assert.match(loader, /lazy\(\(\) => import\("\.\/AppUpdateGate\.jsx"\)\)/);
  const gate = read("src/components/app/AppUpdateGate.jsx");
  assert.doesNotMatch(gate, /dangerouslySetInnerHTML/);
  assert.match(gate, /if \(inFlight\.current\) return/); // one check / one dialog at a time
  assert.match(gate, /removeEventListener\("visibilitychange"/); // listener cleaned up
  assert.match(gate, /pickUpdateUrl\(release\)/);
  assert.match(read("src/App.jsx"), /<AppUpdateLoader \/>/);
  assert.match(read("src/services/public.js"), /"\/api\/public\/app-update"/);
});

test("admin controls live only under /admin (protected routes) and call only /api/admin/*", () => {
  assert.match(read("src/admin/AdminApp.jsx"), /<Route path="app-update" element=\{<AppRelease \/>\} \/>/);
  assert.match(read("src/services/admin.js"), /"\/api\/admin\/app-release"/);
  const adminApp = read("src/admin/AdminApp.jsx");
  assert.ok(adminApp.indexOf('<Route path="app-update"') > adminApp.indexOf("<Protected />"), "route sits inside <Protected>");
  assert.doesNotMatch(read("src/admin/pages/AppRelease.jsx"), /localStorage|sessionStorage|dangerouslySetInnerHTML/);
});

test("Android side: local plugin registered, https-only link opening, NO silent-install permission, remote URL + package id untouched", () => {
  const main = read("android/app/src/main/java/com/atharitv/app/MainActivity.java");
  assert.match(main, /registerPlugin\(AthariAppPlugin\.class\);\s*super\.onCreate/); // registered before super.onCreate
  const plugin = read("android/app/src/main/java/com/atharitv/app/AthariAppPlugin.java");
  assert.match(plugin, /@CapacitorPlugin\(name = "AthariApp"\)/);
  assert.match(plugin, /equalsIgnoreCase\(uri\.getScheme\(\)\)/);
  assert.doesNotMatch(plugin, /FileProvider|DownloadManager|PackageInstaller|application\/vnd\.android\.package-archive/);
  assert.doesNotMatch(read("android/app/src/main/AndroidManifest.xml"), /REQUEST_INSTALL_PACKAGES/);
  const cfg = JSON.parse(read("capacitor.config.json"));
  assert.equal(cfg.appId, "com.atharitv.app");
  assert.equal(cfg.server.url, "https://atharitv-website.pages.dev");
  assert.match(read("android/app/build.gradle"), /applicationId "com\.atharitv\.app"/);
});
