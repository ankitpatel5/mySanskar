/* ============================================================
   Baal Shravan — Firebase initialization
   The API key below is safe to expose in client-side code.
   Security is enforced entirely by Firestore security rules.
   ============================================================ */

const _fbApp = firebase.initializeApp({
  apiKey:            'AIzaSyDFuSC30kTeBzHlCLidpDP1a3_6IGzfddY',
  authDomain:        'baal-shravan.firebaseapp.com',
  projectId:         'baal-shravan',
  storageBucket:     'baal-shravan.firebasestorage.app',
  messagingSenderId: '566163854295',
  appId:             '1:566163854295:web:1528daeb0d3509a878f192',
});

window.fbAuth     = firebase.auth();
window.fbDb       = firebase.firestore();
window.fbGoogle   = new firebase.auth.GoogleAuthProvider();
