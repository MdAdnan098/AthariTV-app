package com.atharitv.app;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Small local Capacitor plugin used by the website's update check (Phase 2). No npm package is involved.
 *
 *  - getAppInfo()                 -> { versionName, versionCode, packageName } of the INSTALLED app.
 *  - openExternalUrl({ url })     -> opens an official https:// link (APK download page / store listing) in the
 *                                    phone's browser. Android's own download and "install this app?" screens do the rest,
 *                                    so the user always approves the install. Nothing is installed silently and the
 *                                    REQUEST_INSTALL_PACKAGES permission is NOT used.
 *
 * Push notifications (Phase 3) also use this plugin for ONE thing: when the user taps a notification that the Android system
 * tray showed (app closed or in the background), the launch intent carries the notification's data. captureNotificationLink()
 * reads the page path from it (`link`, e.g. /article/my-post) and hands it to the website as the "notificationLink" event.
 * The event is retained until the page has registered its listener, so it also works for a cold start.
 *
 * The URL is validated here again (https only, no credentials, public host name) even though the website and the
 * server validate it too: this is the last line of defence before anything leaves the app.
 */
@CapacitorPlugin(name = "AthariApp")
public class AthariAppPlugin extends Plugin {

    private static final int MAX_URL_LENGTH = 2048;
    private static final int MAX_LINK_LENGTH = 512;

    /** The plugin instance once the bridge has loaded it (null before that). */
    private static AthariAppPlugin instance;
    /** A link captured before the plugin was loaded; delivered as soon as it is. */
    private static String pendingLink;

    @Override
    public void load() {
        instance = this;
        if (pendingLink != null) {
            String link = pendingLink;
            pendingLink = null;
            deliverLink(link);
        }
    }

    @Override
    protected void handleOnDestroy() {
        if (instance == this) instance = null;
    }

    private void deliverLink(String link) {
        JSObject data = new JSObject();
        data.put("link", link);
        // retainUntilConsumed = true: kept until the web page adds its listener (cold start), then delivered once.
        notifyListeners("notificationLink", data, true);
    }

    /**
     * Called by MainActivity for the launch intent and for every new intent. Reads `link` (a page of the website) from the
     * notification's data and forwards it. The value is validated: only a path of this site is ever opened.
     */
    static void captureNotificationLink(Intent intent) {
        if (intent == null) return;
        Bundle extras = intent.getExtras();
        if (extras == null) return;
        Object raw = extras.get("link");
        if (!(raw instanceof String)) return;
        // Consume it, so a configuration change / re-delivery of the same intent does not navigate again.
        intent.removeExtra("link");
        String link = sanitizeLink((String) raw);
        if (link == null) return;
        AthariAppPlugin plugin = instance;
        if (plugin != null) plugin.deliverLink(link);
        else pendingLink = link;
    }

    /** A page of the website itself: starts with a single "/", no control characters, no backslash, not the admin panel. */
    static String sanitizeLink(String link) {
        if (link == null) return null;
        String value = link.trim();
        if (value.isEmpty() || value.length() > MAX_LINK_LENGTH) return null;
        if (!value.startsWith("/") || value.startsWith("//")) return null;
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (c < 0x20 || c == 0x7f || c == '\\') return null;
        }
        String lower = value.toLowerCase();
        if (lower.equals("/admin") || lower.startsWith("/admin/") || lower.startsWith("/admin?") || lower.startsWith("/admin#")) return null;
        return value;
    }

    @SuppressWarnings("deprecation")
    @PluginMethod
    public void getAppInfo(PluginCall call) {
        try {
            String packageName = getContext().getPackageName();
            PackageInfo info = getContext().getPackageManager().getPackageInfo(packageName, 0);
            long versionCode = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P ? info.getLongVersionCode() : info.versionCode;
            JSObject result = new JSObject();
            result.put("versionName", info.versionName == null ? "" : info.versionName);
            result.put("versionCode", versionCode);
            result.put("packageName", packageName);
            call.resolve(result);
        } catch (Exception e) {
            call.reject("Could not read the app version.");
        }
    }

    @PluginMethod
    public void openExternalUrl(PluginCall call) {
        String url = call.getString("url");
        if (!isSafeHttpsUrl(url)) {
            call.reject("Unsafe or invalid URL.");
            return;
        }
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            intent.addCategory(Intent.CATEGORY_BROWSABLE);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            JSObject result = new JSObject();
            result.put("opened", true);
            call.resolve(result);
        } catch (ActivityNotFoundException e) {
            call.reject("No app on this phone can open the link.");
        } catch (Exception e) {
            call.reject("Could not open the link.");
        }
    }

    /** https only, no user:password@, a real public host name (no IP address, localhost, single-label or .local host). */
    static boolean isSafeHttpsUrl(String url) {
        if (url == null || url.isEmpty() || url.length() > MAX_URL_LENGTH) return false;
        Uri uri = Uri.parse(url);
        if (!"https".equalsIgnoreCase(uri.getScheme())) return false;
        if (uri.getUserInfo() != null) return false;
        String host = uri.getHost();
        if (host == null || host.isEmpty()) return false;
        host = host.toLowerCase();
        if (host.startsWith("[") || host.contains(":")) return false; // IPv6 literal
        if (host.matches("\\d{1,3}(\\.\\d{1,3}){3}")) return false; // IPv4 literal
        if (!host.contains(".") || host.equals("localhost") || host.endsWith(".local") || host.endsWith(".internal")) return false;
        return true;
    }
}
