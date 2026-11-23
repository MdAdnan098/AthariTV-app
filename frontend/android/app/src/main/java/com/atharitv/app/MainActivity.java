package com.atharitv.app;

import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.SystemClock;
import android.view.View;
import android.webkit.WebBackForwardList;
import android.webkit.WebHistoryItem;
import android.webkit.WebView;
import android.widget.Toast;

import androidx.activity.OnBackPressedCallback;

import com.getcapacitor.BridgeActivity;

import org.json.JSONObject;

/**
 * AthariTV main activity.
 *
 * Back button behaviour (Phase 1):
 *  - Home page ("/")                  -> press Back twice within 2 s to exit (a toast explains it).
 *  - Any other page with history      -> go back one step in the WebView history. The website is a React Router
 *                                        single-page app, so every in-app navigation is a history entry.
 *  - Any other page WITHOUT history   -> (deep link / app restored on a detail page) go to the parent page
 *                                        instead of closing the app, e.g. /aqaid/xyz -> /aqaid -> /.
 *  - A page outside the app's own site (e.g. a payment page) -> plain WebView back, never the parent-page logic.
 *
 * One OnBackPressedCallback is registered once and is bound to this activity's lifecycle, so there are no duplicate
 * listeners and nothing is leaked. It uses the AndroidX dispatcher because the legacy Activity.onBackPressed()
 * is not called for apps targeting Android 16 (targetSdk 36, predictive back).
 */
public class MainActivity extends BridgeActivity {

    private static final long EXIT_WINDOW_MS = 2000L;

    private long lastBackPressAt = 0L;
    private Toast exitToast;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Local plugin for the Android update check (app version + opening the official download link).
        // Plugins must be registered BEFORE super.onCreate().
        registerPlugin(AthariAppPlugin.class);
        super.onCreate(savedInstanceState);

        // Make sure Android Autofill (Google Password Manager etc.) is allowed to see the WebView's login fields.
        // This is already the WebView default; setting it explicitly guards against it being turned off.
        WebView webView = getBridge() != null ? getBridge().getWebView() : null;
        if (webView != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            webView.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_YES);
        }

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                handleBack();
            }
        });
    }

    private void handleBack() {
        WebView webView = getBridge() != null ? getBridge().getWebView() : null;
        if (webView == null) {
            exitOnSecondPress();
            return;
        }

        String current = webView.getUrl();
        if (!isAppPage(webView, current)) {
            // External / unknown page: just behave like a normal browser.
            if (webView.canGoBack()) {
                webView.goBack();
            } else {
                exitOnSecondPress();
            }
            return;
        }

        String path = normalizePath(Uri.parse(current).getEncodedPath());
        if ("/".equals(path)) {
            exitOnSecondPress();
            return;
        }

        if (webView.canGoBack()) {
            webView.goBack();
            return;
        }

        goToParent(webView, parentOf(path));
    }

    /** True when the current page is on the same site as the first page the WebView loaded (the app's own site). */
    private boolean isAppPage(WebView webView, String current) {
        String currentHost = hostOf(current);
        if (currentHost == null) return false;
        WebBackForwardList list = webView.copyBackForwardList();
        if (list == null || list.getSize() == 0) return false;
        WebHistoryItem first = list.getItemAtIndex(0);
        String firstHost = first == null ? null : hostOf(first.getUrl());
        return firstHost != null && firstHost.equalsIgnoreCase(currentHost);
    }

    private static String hostOf(String url) {
        if (url == null) return null;
        try {
            return Uri.parse(url).getHost();
        } catch (Exception e) {
            return null;
        }
    }

    private static String normalizePath(String path) {
        if (path == null || path.isEmpty()) return "/";
        if (path.length() > 1 && path.endsWith("/")) path = path.substring(0, path.length() - 1);
        return path;
    }

    private static String parentOf(String path) {
        // Signed-out admin pages: their "parent" (/admin) would just redirect back to the login page, so go home.
        if ("/admin/login".equals(path) || "/admin/register".equals(path) || "/admin/forgot-password".equals(path)) {
            return "/";
        }
        // There is no /article list page (only /article/:slug), so an article's parent is the home page.
        if (path.startsWith("/article/")) {
            return "/";
        }
        int idx = path.lastIndexOf('/');
        return idx <= 0 ? "/" : path.substring(0, idx);
    }

    /** Client-side navigation through the page's own History API so React Router handles it (no full reload). */
    private void goToParent(WebView webView, String parentPath) {
        String quoted = JSONObject.quote(parentPath);
        String js = "(function(){try{history.pushState(null,''," + quoted + ");"
                + "window.dispatchEvent(new PopStateEvent('popstate',{state:null}));}"
                + "catch(e){window.location.assign(" + quoted + ");}})();";
        webView.evaluateJavascript(js, null);
    }

    private void exitOnSecondPress() {
        long now = SystemClock.elapsedRealtime();
        if (lastBackPressAt != 0L && now - lastBackPressAt <= EXIT_WINDOW_MS) {
            if (exitToast != null) exitToast.cancel();
            finish();
            return;
        }
        lastBackPressAt = now;
        if (exitToast != null) exitToast.cancel();
        exitToast = Toast.makeText(getApplicationContext(), R.string.press_back_again_to_exit, Toast.LENGTH_SHORT);
        exitToast.show();
    }
}
