package com.atharitv.app;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.net.Uri;
import android.os.Build;

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
 * The URL is validated here again (https only, no credentials, public host name) even though the website and the
 * server validate it too: this is the last line of defence before anything leaves the app.
 */
@CapacitorPlugin(name = "AthariApp")
public class AthariAppPlugin extends Plugin {

    private static final int MAX_URL_LENGTH = 2048;

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
