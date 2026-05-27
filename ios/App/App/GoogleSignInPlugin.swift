import Foundation
import Capacitor
import GoogleSignIn

/// Minimal native Google Sign-In plugin for Capacitor 8.
/// Called from app.js via window.Capacitor.Plugins.GoogleSignIn.signIn()
@objc(GoogleSignInPlugin)
public class GoogleSignInPlugin: CAPPlugin, CAPBridgedPlugin {

    public let identifier = "GoogleSignInPlugin"
    public let jsName    = "GoogleSignIn"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "signIn",  returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "signOut", returnType: CAPPluginReturnPromise),
    ]

    @objc func signIn(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let vc = self.bridge?.viewController else {
                call.reject("No root view controller")
                return
            }
            GIDSignIn.sharedInstance.signIn(withPresenting: vc) { result, error in
                if let error = error {
                    // GIDSignInError.canceled (code −5) — user dismissed the sheet.
                    // Return a stable machine-readable code so the JS layer can
                    // distinguish a deliberate cancel from an actual failure.
                    let nsError = error as NSError
                    if nsError.code == -5 {
                        call.reject("SIGN_IN_CANCELLED", nil, error)
                    } else {
                        call.reject(error.localizedDescription, nil, error)
                    }
                    return
                }
                guard let user   = result?.user,
                      let idToken = user.idToken?.tokenString else {
                    call.reject("No ID token returned")
                    return
                }
                call.resolve([
                    "idToken":      idToken,
                    "accessToken":  user.accessToken.tokenString,
                    "email":        user.profile?.email        ?? "",
                    "displayName":  user.profile?.name         ?? "",
                    "photoURL":     user.profile?.imageURL(withDimension: 96)?.absoluteString ?? "",
                ])
            }
        }
    }

    @objc func signOut(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            GIDSignIn.sharedInstance.signOut()
            call.resolve()
        }
    }
}
