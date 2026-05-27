package com.ankit.mysanskar;

import android.content.Intent;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.gms.auth.api.signin.GoogleSignIn;
import com.google.android.gms.auth.api.signin.GoogleSignInAccount;
import com.google.android.gms.auth.api.signin.GoogleSignInClient;
import com.google.android.gms.auth.api.signin.GoogleSignInOptions;
import com.google.android.gms.common.api.ApiException;
import com.google.android.gms.tasks.Task;

/**
 * Native Google Sign-In plugin for Capacitor (Android).
 * Called from app.js via window.Capacitor.Plugins.GoogleSignIn.signIn()
 * Returns an idToken which app.js exchanges for a Firebase credential.
 */
@CapacitorPlugin(name = "GoogleSignIn")
public class GoogleSignInPlugin extends Plugin {

    // Web client ID from Google Cloud Console
    private static final String WEB_CLIENT_ID =
        "566163854295-15ahk0aksc12uqug363b40jac1g50f8i.apps.googleusercontent.com";

    @PluginMethod
    public void signIn(PluginCall call) {
        GoogleSignInOptions gso = new GoogleSignInOptions.Builder(GoogleSignInOptions.DEFAULT_SIGN_IN)
            .requestIdToken(WEB_CLIENT_ID)
            .requestEmail()
            .requestProfile()
            .build();

        GoogleSignInClient client = GoogleSignIn.getClient(getActivity(), gso);
        // Sign out first so the account picker always appears
        client.signOut().addOnCompleteListener(task -> {
            Intent signInIntent = client.getSignInIntent();
            startActivityForResult(call, signInIntent, "handleSignInResult");
        });
    }

    @ActivityCallback
    void handleSignInResult(PluginCall call, ActivityResult result) {
        // getData() is null when the user presses the device Back button to dismiss
        // the sign-in sheet — treat it the same as a deliberate cancel.
        if (result.getData() == null) {
            call.reject("SIGN_IN_CANCELLED");
            return;
        }
        Task<GoogleSignInAccount> task =
            GoogleSignIn.getSignedInAccountFromIntent(result.getData());
        try {
            GoogleSignInAccount account = task.getResult(ApiException.class);
            String idToken = account.getIdToken();
            if (idToken == null) {
                call.reject("No ID token returned");
                return;
            }
            JSObject ret = new JSObject();
            ret.put("idToken", idToken);
            ret.put("accessToken", "");
            ret.put("email", account.getEmail() != null ? account.getEmail() : "");
            ret.put("displayName", account.getDisplayName() != null ? account.getDisplayName() : "");
            ret.put("photoURL", account.getPhotoUrl() != null ? account.getPhotoUrl().toString() : "");
            call.resolve(ret);
        } catch (ApiException e) {
            // Status code 12501 = user cancelled the sign-in dialog
            if (e.getStatusCode() == 12501) {
                call.reject("SIGN_IN_CANCELLED");
            } else {
                call.reject("Sign in failed (" + e.getStatusCode() + ")");
            }
        }
    }

    @PluginMethod
    public void signOut(PluginCall call) {
        GoogleSignInClient client = GoogleSignIn.getClient(
            getActivity(), GoogleSignInOptions.DEFAULT_SIGN_IN);
        client.signOut().addOnCompleteListener(task -> call.resolve());
    }
}
