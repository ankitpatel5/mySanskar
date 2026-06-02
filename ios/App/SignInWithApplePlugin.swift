import Foundation
import Capacitor
import AuthenticationServices

@objc(SignInWithApple)
public class SignInWithApple: CAPPlugin, ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding {

    private var savedCall: CAPPluginCall?

    @objc func authorize(_ call: CAPPluginCall) {
        self.savedCall = call

        let provider = ASAuthorizationAppleIDProvider()
        let request  = provider.createRequest()
        request.requestedScopes = [.fullName, .email]

        let controller = ASAuthorizationController(authorizationRequests: [request])
        controller.delegate                    = self
        controller.presentationContextProvider = self
        controller.performRequests()
    }

    // MARK: - ASAuthorizationControllerPresentationContextProviding
    public func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        return self.bridge?.viewController?.view.window ?? UIWindow()
    }

    // MARK: - ASAuthorizationControllerDelegate
    public func authorizationController(controller: ASAuthorizationController,
                                        didCompleteWithAuthorization authorization: ASAuthorization) {
        guard let call = savedCall else { return }

        if let credential = authorization.credential as? ASAuthorizationAppleIDCredential {
            let identityToken = credential.identityToken.flatMap { String(data: $0, encoding: .utf8) } ?? ""
            let authCode      = credential.authorizationCode.flatMap { String(data: $0, encoding: .utf8) } ?? ""
            let userID        = credential.user
            let email         = credential.email ?? ""
            let firstName     = credential.fullName?.givenName ?? ""
            let lastName      = credential.fullName?.familyName ?? ""

            call.resolve([
                "response": [
                    "identityToken": identityToken,
                    "authorizationCode": authCode,
                    "user": userID,
                    "email": email,
                    "givenName": firstName,
                    "familyName": lastName,
                ]
            ])
        } else {
            call.reject("Unexpected credential type")
        }
        savedCall = nil
    }

    public func authorizationController(controller: ASAuthorizationController,
                                        didCompleteWithError error: Error) {
        let err = error as? ASAuthorizationError
        if err?.code == .canceled {
            savedCall?.reject("SIGN_IN_CANCELLED")
        } else {
            savedCall?.reject(error.localizedDescription)
        }
        savedCall = nil
    }
}
