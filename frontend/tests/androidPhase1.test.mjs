// Phase 1 (Android app): launcher icons, hardware Back button handler, admin login form semantics.
// Source-level checks only (no Android SDK / device needed), same style as brandAssets.test.mjs.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const url = (rel) => new URL(`../${rel}`, import.meta.url);
const read = (rel) => readFileSync(url(rel), "utf8");
const RES = "android/app/src/main/res";

function pngSize(rel) {
  const b = readFileSync(url(rel));
  assert.equal(b.slice(1, 4).toString(), "PNG", `${rel} is not a PNG`);
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

test("launcher icons: every density has foreground (108dp), legacy and round (48dp) PNGs at the exact pixel size", () => {
  const scale = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
  for (const [d, k] of Object.entries(scale)) {
    assert.deepEqual(pngSize(`${RES}/mipmap-${d}/ic_launcher_foreground.png`), [108 * k, 108 * k], `${d} foreground`);
    assert.deepEqual(pngSize(`${RES}/mipmap-${d}/ic_launcher.png`), [48 * k, 48 * k], `${d} legacy`);
    assert.deepEqual(pngSize(`${RES}/mipmap-${d}/ic_launcher_round.png`), [48 * k, 48 * k], `${d} round`);
  }
});

test("adaptive icon: foreground is the mipmap PNG, background is a colour that matches the logo's black, no default Capacitor vector is referenced", () => {
  for (const f of ["ic_launcher.xml", "ic_launcher_round.xml"]) {
    const x = read(`${RES}/mipmap-anydpi-v26/${f}`);
    assert.match(x, /<adaptive-icon/);
    assert.match(x, /<foreground android:drawable="@mipmap\/ic_launcher_foreground"\/>/);
    assert.match(x, /<background android:drawable="@color\/ic_launcher_background"\/>/);
  }
  assert.match(read(`${RES}/values/ic_launcher_background.xml`), /"ic_launcher_background">#000000</);
  const manifest = read("android/app/src/main/AndroidManifest.xml");
  assert.match(manifest, /android:icon="@mipmap\/ic_launcher"/);
  assert.match(manifest, /android:roundIcon="@mipmap\/ic_launcher_round"/);
});

test("the icon source logo exists", () => {
  assert.ok(existsSync(url("public/brand/athari-full.webp")));
});

test("MainActivity: ONE lifecycle-bound back callback; Home double-press exit; history back; parent fallback; no Handler/leak", () => {
  const j = read("android/app/src/main/java/com/atharitv/app/MainActivity.java");
  assert.match(j, /extends BridgeActivity/);
  assert.equal((j.match(/addCallback\(/g) || []).length, 1, "exactly one back callback");
  assert.match(j, /addCallback\(this,/); // bound to the activity lifecycle -> removed automatically
  assert.match(j, /canGoBack\(\)/);
  assert.match(j, /goBack\(\)/);
  assert.match(j, /EXIT_WINDOW_MS/);
  assert.doesNotMatch(j, /new Handler|postDelayed/); // nothing that can outlive the activity
  assert.match(j, /press_back_again_to_exit/);
  assert.match(read(`${RES}/values/strings.xml`), /name="press_back_again_to_exit"/);
});

test("MainActivity does not hard-code the website URL (capacitor.config.json stays the single source)", () => {
  const j = read("android/app/src/main/java/com/atharitv/app/MainActivity.java");
  assert.doesNotMatch(j, /pages\.dev|https?:\/\//);
  const cfg = JSON.parse(read("capacitor.config.json"));
  assert.equal(cfg.appId, "com.atharitv.app");
  assert.equal(cfg.server.url, "https://atharitv-website.pages.dev");
});

test("admin Login: real <form> + submit button, username/current-password autocomplete, names, no storage of the password", () => {
  const s = read("src/admin/pages/Login.jsx");
  assert.match(s, /<form onSubmit=\{submit\}/);
  assert.match(s, /<button type="submit"/);
  assert.match(s, /id="un" name="username" type="text"[^>]*autoComplete="username"/);
  assert.match(s, /id="pw" name="password" type=\{showPw \? "text" : "password"\}[^>]*autoComplete="current-password"/);
  // existing protections are still there: only a real user action logs in, one request at a time
  assert.match(s, /!e\.isTrusted/);
  assert.match(s, /inFlight\.current/);
  assert.match(s, /e\.preventDefault\(\)/);
  assert.doesNotMatch(s, /localStorage|sessionStorage/);
});
