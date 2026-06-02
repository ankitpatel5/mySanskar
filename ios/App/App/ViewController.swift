import UIKit
import Capacitor
import WebKit

/// Custom bridge view controller — registers local plugins and
/// prevents stale Firebase redirect state from hijacking the WebView.
class ViewController: CAPBridgeViewController {

    override func capacitorDidLoad() {
        // Register our native Google Sign-In plugin with the Capacitor bridge.
        bridge?.registerPluginInstance(GoogleSignInPlugin())
        bridge?.registerPluginInstance(SignInWithApple())

        // Inject a script that runs before any page JS so we can clear
        // any stale Firebase redirect state left by previous signInWithRedirect
        // attempts. Without this, Firebase tries to complete the redirect,
        // fails (WKWebView partitions sessionStorage), and shows an error page.
        let clearRedirectState = """
        (function() {
            if (typeof sessionStorage !== 'undefined') {
                Object.keys(sessionStorage).forEach(function(key) {
                    if (key.indexOf('firebase') !== -1) {
                        sessionStorage.removeItem(key);
                    }
                });
            }
        })();
        """
        let script = WKUserScript(
            source: clearRedirectState,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )
        webView?.configuration.userContentController.addUserScript(script)

        // Block navigations to Firebase's auth domain using a content rule list.
        // This avoids replacing Capacitor's WKNavigationDelegate (which would
        // break bridge initialisation, certificate handling, and deep links).
        // The rule only affects this WKWebView — not the native Google Sign-In
        // sheet (which uses ASWebAuthenticationSession / SFSafariViewController).
        let blockFirebaseRule = """
        [{
            "trigger": { "url-filter": ".*\\\\.firebaseapp\\\\.com.*" },
            "action":  { "type": "block" }
        }]
        """
        WKContentRuleListStore.default().compileContentRuleList(
            forIdentifier: "BlockFirebaseAuthRedirect",
            encodedContentRuleList: blockFirebaseRule
        ) { [weak self] ruleList, error in
            guard let ruleList = ruleList else {
                if let error = error {
                    print("[ViewController] WKContentRuleList compile error: \(error)")
                }
                return
            }
            DispatchQueue.main.async {
                self?.webView?.configuration.userContentController.add(ruleList)
            }
        }
    }
}
