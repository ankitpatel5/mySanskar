/* ============================================================
   Drift — vanilla JS music player
   - Reads MP3s recursively from a public Google Drive folder
   - Persists playlists & queue in localStorage
   - Mobile-first, dark, Spotify-flavored
   ============================================================ */

(() => {
  'use strict';

  // ============== STORAGE KEYS ==============
  const LS = {
    apiKey: 'drift.apiKey',
    folderId: 'drift.folderId',
    library: 'drift.library',
    playlists: 'drift.playlists',
    queue: 'drift.queue',
    lastTrack: 'drift.lastTrack',
    loop: 'drift.loop',
    shuffle: 'drift.shuffle',
    playCounts: 'drift.playCounts',
    libraryView: 'drift.libraryView',
    theme: 'drift.theme',
    storyLangDefault: 'drift.storyLangDefault',
    activeTab: 'drift.activeTab',
    activeMusicSubTab: 'drift.activeMusicSubTab',
    audiobooksEnabled: 'drift.audiobooksEnabled',
  };

  // ============== THEME ==============
  const MOON_SVG = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3a7 7 0 0 0 9.79 9.79z"/></svg>`;
  const SUN_SVG  = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>`;

  function currentTheme() {
    return document.documentElement.getAttribute('data-theme') || 'dark';
  }
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem(LS.theme, theme);
    const btn = $('theme-btn');
    if (btn) btn.innerHTML = theme === 'dark' ? SUN_SVG : MOON_SVG;
  }
  function toggleTheme() {
    applyTheme(currentTheme() === 'dark' ? 'light' : 'dark');
  }

  const cfg = window.DRIFT_CONFIG || {};
  let API_KEY = localStorage.getItem(LS.apiKey) || cfg.apiKey || '';
  let ROOT_FOLDER_ID = localStorage.getItem(LS.folderId) || cfg.folderId || '';

  // ============== STATE ==============
  const state = {
    library: null,
    flatTracks: [],
    trackById: {},
    playlists: [],
    queue: [],
    history: [],
    currentTrackId: null,
    loop: false,
    shuffle: false,
    playing: false,
    currentSource: { kind: 'none', payload: null },
    activeAlbum: null,
    activePlaylist: null,
    pendingTrackId: null,
    pendingContext: null,
    pendingShareDoc: null,
    currentTab: 'home',
    musicSubTab: 'library',
    playCounts: {},
    libraryView: 'list',
    user: null,
    isGuest: false,
    currentStory: null,
    currentCatId: null,
    storyListLang: localStorage.getItem('drift.storyListLang') || 'en',
    isVIPTTS: false,
    hasPrerenderedTTS: false,  // true when prerenderedTTS/{storyId} exists for the current story
    audiobooksEnabled: false,
  };

  // ── Guest mode helpers ──────────────────────────────────────────
  const GUEST_STORY_LIMIT = 10;
  const GUEST_STORY_CATS  = ['satsang', 'hindu', 'moral']; // categories that get the 10-story cap

  function isGuestMode() { return state.isGuest === true; }

  // Called from any "Create a free account" CTA in guest mode — sends user back to sign-in screen
  function promptGuestSignIn() {
    ['user-menu', 'settings-modal', 'confirm-modal'].forEach((id) => {
      const el = $(id); if (el) el.classList.add('hidden');
    });
    state.isGuest = false;
    state.user    = null;
    _appBooted    = false;
    $('main-screen').classList.add('hidden');
    $('signin-screen').classList.remove('hidden');
  }

  // ============== DOM ==============
  const $ = (id) => document.getElementById(id);
  const audio = $('audio');

  // Sets the story hero image with blurred backdrop, or hides it
  function setStoryHeroImage(src) {
    const wrap = $('story-reader-img-wrap');
    const blur = $('story-reader-img-blur');
    const img  = $('story-reader-img');
    if (!wrap) return;
    if (src) {
      img.src = src;
      blur.style.backgroundImage = `url('${src.replace(/'/g, "\\'")}')`;
      wrap.classList.remove('hidden', 'ai-img-loading');
      img.onerror = () => { wrap.classList.add('hidden'); };
    } else {
      img.src = '';
      blur.style.backgroundImage = '';
      wrap.classList.add('hidden');
      wrap.classList.remove('ai-img-loading');
    }
  }

  // Shows a shimmer placeholder while an AI image is being generated
  function setStoryHeroShimmer() {
    const wrap = $('story-reader-img-wrap');
    const img  = $('story-reader-img');
    if (!wrap) return;
    img.src = '';
    wrap.classList.remove('hidden');
    wrap.classList.add('ai-img-loading');
  }

  // ============== INIT ==============
  let _appBooted = false; // guard: only run full setup once

  // Clear user-specific localStorage keys when a different user signs in.
  // Prevents child profile, onboarding state, playlists, and play counts
  // from leaking between accounts on the same device.
  function clearPerUserLocalStorage() {
    const USER_KEYS = [
      'drift.childName', 'drift.childGender', 'drift.childDob',
      'drift.onboardingDone',
      LS.playlists, LS.playCounts, LS.lastTrack,
      LS.queue, LS.library,
    ];
    USER_KEYS.forEach((k) => localStorage.removeItem(k));
  }

  async function proceedAsUser(user) {
    if (_appBooted) { hideLoading(); return; } // already running
    _appBooted = true;

    // If a different user was previously signed in on this device, wipe their
    // user-specific localStorage so their child profile / onboarding state
    // don't bleed into the new account.
    const prevUid = localStorage.getItem('drift.lastUserId');
    if (prevUid && prevUid !== user.uid) {
      clearPerUserLocalStorage();
    }
    localStorage.setItem('drift.lastUserId', user.uid);

    // Show UI immediately — don't block on any network call
    state.user = user;
    loadPersistedState();
    updateUserUI();
    if (!API_KEY || !ROOT_FOLDER_ID) {
      hideLoading();
      showSetup();
      return;
    }
    showMain(); // hides loading overlay, shows app

    setupEventListeners();
    // Restore the tab the user was on — must happen after setupEventListeners
    // so tab buttons and sub-nav exist in the DOM.
    switchTab(state.currentTab, state.musicSubTab);
    checkOnboarding();
    loadVoices();
    setupAudio();
    bootstrapLibrary();
    loadFirestorePlaylists();
    syncCompletedStoriesFromFirestore();
    syncChildProfileFromFirestore();
    loadConvTalked();
    syncAudiobooksSettingFromFirestore();
    syncAudiobookProgressFromFirestore();
    initDownloads();
    checkShareParam();

    // Skip auth-dependent setup when booting from the localStorage cache snapshot.
    // The real Firebase User arrives via onAuthStateChanged shortly after and
    // runs these with proper credentials (no duplicate listeners created).
    const isRealFirebaseUser = typeof user.getIdToken === 'function';
    if (!isRealFirebaseUser) return;

    // Blocked-user check runs in background after UI is shown
    // (5s timeout so a hung Firestore call can't leave user in limbo)
    try {
      const blockedDoc = await Promise.race([
        window.fbDb.collection('blockedUsers').doc(user.uid).get(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
      ]);
      if (blockedDoc.exists) {
        await window.fbAuth.signOut();
        window.location.reload();
        return;
      }
    } catch (e) {
      console.warn('blocked-check failed — proceeding', e);
    }

    syncUserProfile(user);
    setupBlockedListener(user);
    checkVIPTTSAccess(user);
    updateAdminUI();
  }

  function proceedAsGuest() {
    hideLoading();
    $('signin-screen').classList.remove('hidden');
    $('main-screen').classList.add('hidden');
    $('setup-screen').classList.add('hidden');
    // Show blocked message if we were just kicked out by the admin
    try {
      if (sessionStorage.getItem('drift.blocked')) {
        sessionStorage.removeItem('drift.blocked');
        const msg = $('blocked-msg');
        if (msg) msg.classList.remove('hidden');
      }
    } catch {}
    // Detect in-app browsers where Google sign-in popups don't work
    // (WhatsApp, Instagram, Facebook, Line, WeChat, TikTok, etc.)
    const ua = navigator.userAgent || '';
    const inAppName = (
      /WhatsApp/i.test(ua)       ? 'WhatsApp' :
      /Instagram/i.test(ua)      ? 'Instagram' :
      /FBAN|FBAV|FB_IAB/i.test(ua) ? 'Facebook' :
      /\bLine\b/i.test(ua)       ? 'Line' :
      /MicroMessenger/i.test(ua) ? 'WeChat' :
      /TikTok/i.test(ua)         ? 'TikTok' :
      /Snapchat/i.test(ua)       ? 'Snapchat' :
      null
    );
    const inAppMsg = $('inapp-browser-msg');
    const inAppName$ = $('inapp-browser-name');
    if (inAppName && inAppMsg) {
      inAppMsg.classList.remove('hidden');
      if (inAppName$) inAppName$.textContent = inAppName;
    }

    // Wire Apple sign-in button (only once)
    // Apple Sign-In only works on native iOS — hide the button on web browsers
    const appleBtn = $('apple-signin-btn');
    const _isNativeForApple = !!(window.Capacitor &&
      (window.Capacitor.isNativePlatform ? window.Capacitor.isNativePlatform() : false) &&
      window.Capacitor.getPlatform?.() === 'ios');
    if (appleBtn && !_isNativeForApple) {
      // On web: hide Apple button, its divider, and the guest option — iOS-only features
      appleBtn.style.display = 'none';
      const divider = appleBtn.previousElementSibling;
      if (divider && divider.classList.contains('signin-divider')) divider.style.display = 'none';
      const guestDivider = appleBtn.nextElementSibling;
      if (guestDivider && guestDivider.classList.contains('signin-divider')) guestDivider.style.display = 'none';
      const guestBtn2 = $('guest-signin-btn');
      if (guestBtn2) guestBtn2.style.display = 'none';
    }
    if (appleBtn && !appleBtn.dataset.wired) {
      appleBtn.dataset.wired = '1';
      appleBtn.addEventListener('click', () => {
        const isNative = !!(window.Capacitor &&
          (window.Capacitor.isNativePlatform
            ? window.Capacitor.isNativePlatform()
            : true));
        if (isNative) {
          // Native iOS — use Capacitor Sign-in with Apple plugin
          const nativeAppleSignIn = window.Capacitor?.Plugins?.SignInWithApple;
          if (!nativeAppleSignIn) {
            toast('Apple Sign-in plugin not available');
            return;
          }
          (async () => {
            try {
              appleBtn.disabled = true;
              const result = await nativeAppleSignIn.authorize();
              const idToken = result?.response?.identityToken;
              if (!idToken) throw new Error('No identity token from Apple');
              const provider = new firebase.auth.OAuthProvider('apple.com');
              const credential = provider.credential({ idToken });
              await window.fbAuth.signInWithCredential(credential);
              // onAuthStateChanged fires and handles the rest
            } catch (e) {
              const errMsg = e.message || e.code || '';
              if (errMsg !== 'SIGN_IN_CANCELLED') {
                console.error('Apple sign-in error:', errMsg);
                toast('Apple sign-in failed — try again');
              }
              appleBtn.disabled = false;
            }
          })();
        } else {
          // Web — use Firebase popup with Apple provider
          appleBtn.disabled = true;
          const provider = new firebase.auth.OAuthProvider('apple.com');
          provider.addScope('email');
          provider.addScope('name');
          window.fbAuth.signInWithPopup(provider)
            .catch((e) => {
              console.error('Apple sign-in error:', e.code, e.message);
              toast('Apple sign-in failed — try again');
              appleBtn.disabled = false;
            });
        }
      });
    }

    // Wire "Continue as Guest" button (only once)
    const guestBtn = $('guest-signin-btn');
    if (guestBtn && !guestBtn.dataset.wired) {
      guestBtn.dataset.wired = '1';
      guestBtn.addEventListener('click', () => enterGuestMode());
    }

    // Wire sign-in button (only once)
    const btn = $('google-signin-btn');
    if (btn && !btn.dataset.wired) {
      btn.dataset.wired = '1';
      btn.addEventListener('click', () => {
        if (inAppName) {
          // Re-surface the message in case user missed it
          if (inAppMsg) inAppMsg.classList.remove('hidden');
          return;
        }
        btn.disabled = true;
        btn.textContent = 'Signing in…';
        // In native Capacitor app use the native Google Sign-In plugin —
        // WKWebView blocks popups and the redirect flow needs Cordova plugins.
        // On the web, use the standard Firebase popup (better UX, no extra setup).
        const isNative = !!(window.Capacitor &&
          (window.Capacitor.isNativePlatform
            ? window.Capacitor.isNativePlatform()
            : true));
        if (isNative) {
          // Native iOS path — uses our custom GoogleSignInPlugin (Swift + Google Sign-In SDK)
          const nativeGoogleSignIn = window.Capacitor?.Plugins?.GoogleSignIn;
          if (!nativeGoogleSignIn) {
            // Plugin not compiled yet — Google Sign-In SDK not added via SPM in Xcode
            console.error('native sign-in error: GoogleSignIn plugin not available — add GoogleSignIn-iOS via SPM in Xcode');
            btn.disabled = false;
            btn.textContent = 'Try again';
            return;
          }
          (async () => {
            try {
              const result = await nativeGoogleSignIn.signIn();
              const idToken = result?.idToken;
              if (!idToken) throw new Error('No ID token returned from Google Sign-In');
              const credential = firebase.auth.GoogleAuthProvider.credential(idToken);
              await window.fbAuth.signInWithCredential(credential);
              // onAuthStateChanged will fire and handle the rest
            } catch (e) {
              const errMsg = e.message || e.code || '';
              if (errMsg === 'SIGN_IN_CANCELLED') {
                // User deliberately dismissed the sign-in sheet — reset silently.
              } else {
                console.error('native sign-in error:', errMsg);
                btn.textContent = 'Try again';
              }
              btn.disabled = false;
            }
          })();
        } else {
          window.fbAuth.signInWithPopup(window.fbGoogle)
            .catch((e) => {
              console.error('sign-in error:', e.code, e.message);
              btn.disabled = false;
              btn.textContent = 'Try again';
            });
        }
      });
    }
  }

  // ── Guest mode entry — called when user taps "Continue as Guest" ───
  function enterGuestMode() {
    if (_appBooted) return;
    _appBooted    = true;
    state.isGuest = true;
    state.user    = null;

    loadPersistedState();
    updateUserUI();

    if (!API_KEY || !ROOT_FOLDER_ID) {
      hideLoading();
      showSetup();
      return;
    }

    showMain();
    setupEventListeners();
    switchTab(state.currentTab, state.musicSubTab);
    showOnboarding(true); // guest mode = skip child profile screens
    loadVoices();
    setupAudio();
    bootstrapLibrary();
    // No Firestore calls — guests have no account
  }

  function init() {
    // Fast-boot: Firebase stores cached auth in localStorage. If the key exists
    // the user was signed in recently — show the app immediately without waiting
    // for onAuthStateChanged (which can take 2–5s on a cold reload).
    const FB_CACHE_KEY = `firebase:authUser:${window.fbAuth.app.options.apiKey}:[DEFAULT]`;
    let cachedFbUser = null;
    try {
      const raw = localStorage.getItem(FB_CACHE_KEY);
      if (raw) cachedFbUser = JSON.parse(raw);
    } catch {}

    if (cachedFbUser && cachedFbUser.uid) {
      // Boot immediately with the cached snapshot — real auth will follow shortly.
      proceedAsUser({ uid: cachedFbUser.uid, email: cachedFbUser.email || '',
                      displayName: cachedFbUser.displayName || '',
                      photoURL: cachedFbUser.photoURL || '' });
    } else {
      showLoading('Loading…');
    }

    // Fallback: if Firebase stalls (slow network, mobile background restore),
    // check currentUser directly after 8s rather than hanging forever.
    const stallTimer = setTimeout(() => {
      if ($('loading-overlay').classList.contains('hidden')) return;
      try {
        const u = window.fbAuth && window.fbAuth.currentUser;
        u ? proceedAsUser(u) : proceedAsGuest();
      } catch (e) {
        console.warn('stall timer fallback failed:', e);
        proceedAsGuest(); // Last resort — show sign-in screen
      }
    }, 8000);

    // Nuclear fallback: no matter what, clear the loading screen after 15s
    setTimeout(() => {
      if (!$('loading-overlay').classList.contains('hidden')) {
        console.warn('nuclear loading timeout — forcing UI');
        hideLoading();
        if ($('main-screen').classList.contains('hidden')) {
          proceedAsGuest();
        }
      }
    }, 15000);

    window.fbAuth.onAuthStateChanged((user) => {
      clearTimeout(stallTimer);
      if (user) {
        if (_appBooted) {
          // App already showing from fast-boot cache — upgrade state.user to the
          // real Firebase User object so Firestore, tokens, and profile sync work.
          state.user = user;
          updateUserUI();
          updateAdminUI();
          syncUserProfile(user);
          setupBlockedListener(user);
          loadFirestorePlaylists();
          syncCompletedStoriesFromFirestore();
          syncChildProfileFromFirestore();
          syncAIStoriesFromFirestore();
          loadConvTalked();
          syncAudiobooksSettingFromFirestore();
          syncAudiobookProgressFromFirestore();
        } else {
          proceedAsUser(user);
        }
      } else {
        if (_appBooted) {
          // Cached token expired — sign out and reload to show sign-in screen.
          window.fbAuth.signOut().then(() => window.location.reload());
        } else {
          proceedAsGuest();
        }
      }
    });

    // Back-forward cache restore (Chrome + Safari): page resumes from snapshot
    // with loading overlay visible but no new auth event fired.
    window.addEventListener('pageshow', (e) => {
      if (e.persisted && !$('loading-overlay').classList.contains('hidden')) {
        const u = window.fbAuth.currentUser;
        u ? proceedAsUser(u) : proceedAsGuest();
      }
    });

    // Chrome mobile backgrounded tab: JS is throttled, Firebase token refresh
    // stalls. When user returns to the tab, try currentUser immediately.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' &&
          !$('loading-overlay').classList.contains('hidden')) {
        const u = window.fbAuth.currentUser;
        if (u) proceedAsUser(u);
        // If currentUser is null here Firebase is still initializing — the
        // stall timer will handle it if it truly hangs.
      }
    });
  }

  function loadPersistedState() {
    try {
      const pls = JSON.parse(localStorage.getItem(LS.playlists) || '[]');
      state.playlists = Array.isArray(pls) ? pls : [];
    } catch { state.playlists = []; }
    try {
      state.queue = JSON.parse(localStorage.getItem(LS.queue) || '[]');
      if (!Array.isArray(state.queue)) state.queue = [];
    } catch { state.queue = []; }
    state.loop = localStorage.getItem(LS.loop) === '1';
    state.shuffle = localStorage.getItem(LS.shuffle) === '1';
    state.currentTrackId = localStorage.getItem(LS.lastTrack) || null;
    try {
      const pc = JSON.parse(localStorage.getItem(LS.playCounts) || '{}');
      state.playCounts = (pc && typeof pc === 'object') ? pc : {};
    } catch { state.playCounts = {}; }
    state.libraryView = localStorage.getItem(LS.libraryView) || 'list';
    state.audiobooksEnabled = localStorage.getItem(LS.audiobooksEnabled) === '1';
    applyAudiobooksTab();
    const savedTab = localStorage.getItem(LS.activeTab);
    const validTabs = ['music', 'stories', 'home', ...(state.audiobooksEnabled ? ['audiobooks'] : [])];
    if (validTabs.includes(savedTab)) {
      state.currentTab = savedTab;
    }
    const savedSubTab = localStorage.getItem(LS.activeMusicSubTab);
    if (savedSubTab === 'library' || savedSubTab === 'playlists' || savedSubTab === 'queue') {
      state.musicSubTab = savedSubTab;
    }
  }

  function persist(key) {
    try {
      if (key === 'playlists') localStorage.setItem(LS.playlists, JSON.stringify(state.playlists));
      else if (key === 'queue') localStorage.setItem(LS.queue, JSON.stringify(state.queue));
      else if (key === 'loop') localStorage.setItem(LS.loop, state.loop ? '1' : '0');
      else if (key === 'shuffle') localStorage.setItem(LS.shuffle, state.shuffle ? '1' : '0');
      else if (key === 'lastTrack') {
        if (state.currentTrackId) localStorage.setItem(LS.lastTrack, state.currentTrackId);
      } else if (key === 'playCounts') {
        localStorage.setItem(LS.playCounts, JSON.stringify(state.playCounts));
      } else if (key === 'libraryView') {
        localStorage.setItem(LS.libraryView, state.libraryView);
      }
    } catch (e) {
      console.warn('persist failed', e);
    }
  }

  // ============== FIRESTORE ==============
  function playlistsRef() {
    return window.fbDb.collection(`users/${state.user.uid}/playlists`);
  }

  async function loadFirestorePlaylists() {
    if (!state.user) return;
    try {
      const snap = await playlistsRef().orderBy('createdAt', 'desc').get();
      if (!snap.empty) {
        state.playlists = snap.docs.map((d) => d.data());
        localStorage.setItem(LS.playlists, JSON.stringify(state.playlists));
        if (state.currentTab === 'playlists') renderPlaylists();
      }
    } catch (e) {
      console.warn('Firestore load failed, using local cache', e);
    }
  }

  function syncPlaylist(playlist) {
    if (!state.user) return;
    playlistsRef().doc(playlist.id).set(playlist).catch((e) => {
      console.warn('Firestore sync failed', e);
      toast('Playlist saved locally — sync failed');
    });
  }

  function deletePlaylistFromFirestore(id) {
    if (!state.user) return;
    playlistsRef().doc(id).delete().catch((e) => console.warn('Firestore delete failed', e));
  }

  // ---- Shared playlists (public collection) ----
  function sharedPlaylistsRef() {
    return window.fbDb.collection('sharedPlaylists');
  }

  async function sharePlaylist(playlistId) {
    const p = state.playlists.find((pl) => pl.id === playlistId);
    if (!p) return;
    toast('Creating share link…');
    const shareId = uid();
    const shareDoc = {
      id: shareId,
      ownerId: state.user.uid,
      ownerName: state.user.displayName || state.user.email || 'Someone',
      ownerPhoto: state.user.photoURL || '',
      playlistName: p.name,
      trackIds: p.trackIds.slice(),
      createdAt: Date.now(),
    };
    try {
      await sharedPlaylistsRef().doc(shareId).set(shareDoc);
      const url = `${location.origin}${location.pathname}?share=${shareId}`;
      try {
        await navigator.clipboard.writeText(url);
        toast('Share link copied to clipboard!');
      } catch {
        // Clipboard API unavailable — surface the URL
        window.prompt('Copy this share link:', url);
      }
    } catch (e) {
      console.error('Share failed', e);
      toast('Could not create share link');
    }
  }

  async function checkShareParam() {
    const shareId = new URLSearchParams(location.search).get('share');
    if (!shareId) return;
    // Clean the URL immediately so a refresh doesn't re-trigger the modal
    history.replaceState({}, '', location.pathname);
    try {
      const doc = await sharedPlaylistsRef().doc(shareId).get();
      if (!doc.exists) { toast('Share link not found'); return; }
      showImportModal(doc.data());
    } catch (e) {
      console.warn('Could not load shared playlist', e);
    }
  }

  function showImportModal(shareDoc) {
    state.pendingShareDoc = shareDoc;
    const count = Array.isArray(shareDoc.trackIds) ? shareDoc.trackIds.length : 0;
    $('import-title').textContent = shareDoc.playlistName || 'Untitled';
    $('import-sub').textContent =
      `${count} song${count === 1 ? '' : 's'} · shared by ${shareDoc.ownerName || 'someone'}`;
    applyArt($('import-cover'), shareDoc.playlistName);
    showModal('import-modal');
  }

  function importSharedPlaylist() {
    const doc = state.pendingShareDoc;
    if (!doc) return;
    state.pendingShareDoc = null;
    const p = {
      id: uid(),
      name: doc.playlistName || 'Untitled',
      trackIds: Array.isArray(doc.trackIds) ? doc.trackIds : [],
      createdAt: Date.now(),
    };
    state.playlists.unshift(p);
    persist('playlists');
    syncPlaylist(p);
    closeModal('import-modal');
    switchTab('playlists');
    renderPlaylists();
    openPlaylist(p.id);
    toast(`"${p.name}" added to your library`);
  }

  // ============== USER UI ==============
  function updateUserUI() {
    const u = state.user;

    // Guest mode: show a "G" avatar and guest info
    if (isGuestMode()) {
      const el = $('user-avatar-el');
      const menuAvatar = $('user-menu-avatar');
      if (el) el.textContent = 'G';
      if (menuAvatar) menuAvatar.textContent = 'G';
      const nameEl = $('user-menu-name');
      const emailEl = $('user-menu-email');
      if (nameEl) nameEl.textContent = 'Guest';
      if (emailEl) emailEl.textContent = 'Not signed in';
      // Show "Create a free account" button, hide sign-out
      const createBtn = $('guest-create-account-btn');
      const signoutBtn = $('signout-btn');
      if (createBtn) createBtn.style.display = '';
      if (signoutBtn) signoutBtn.textContent = 'Sign in';
      return;
    }

    if (!u) return;

    // Always reset guest-specific elements for signed-in users
    const createBtn = $('guest-create-account-btn');
    const signoutBtn = $('signout-btn');
    if (createBtn) createBtn.style.display = 'none';
    if (signoutBtn) signoutBtn.textContent = 'Sign out';

    const el = $('user-avatar-el');
    const menuAvatar = $('user-menu-avatar');
    if (u.photoURL) {
      const img = `<img src="${u.photoURL}" alt="${escapeHtml(u.displayName || '')}" />`;
      if (el) el.innerHTML = img;
      if (menuAvatar) menuAvatar.innerHTML = img;
    } else {
      const initial = (u.displayName || u.email || '?').charAt(0).toUpperCase();
      if (el) el.textContent = initial;
      if (menuAvatar) menuAvatar.textContent = initial;
    }
    const nameEl = $('user-menu-name');
    const emailEl = $('user-menu-email');
    if (nameEl) nameEl.textContent = u.displayName || '—';
    if (emailEl) emailEl.textContent = u.email || '—';
  }

  // ============== SCREENS ==============
  function showSetup() {
    $('signin-screen').classList.add('hidden');
    $('setup-screen').classList.remove('hidden');
    $('main-screen').classList.add('hidden');
    $('apikey-input').value = API_KEY || '';
    $('folderid-input').value = ROOT_FOLDER_ID || cfg.folderId || '';
    $('setup-save').addEventListener('click', () => {
      const k = $('apikey-input').value.trim();
      const f = $('folderid-input').value.trim();
      if (!k) { toast('Enter an API key'); return; }
      if (!f) { toast('Enter a folder ID'); return; }
      API_KEY = k;
      ROOT_FOLDER_ID = parseFolderId(f);
      localStorage.setItem(LS.apiKey, API_KEY);
      localStorage.setItem(LS.folderId, ROOT_FOLDER_ID);
      window.location.reload();
    });
  }

  function showMain() {
    $('signin-screen').classList.add('hidden');
    $('setup-screen').classList.add('hidden');
    $('main-screen').classList.remove('hidden');
    hideLoading(); // auth confirmed — stop blocking; library loads in background
  }

  function parseFolderId(input) {
    const m = input.match(/folders\/([a-zA-Z0-9_-]+)/);
    return m ? m[1] : input;
  }

  // ============== GOOGLE DRIVE CLIENT ==============
  async function driveList(params) {
    const url = new URL('https://www.googleapis.com/drive/v3/files');
    url.searchParams.set('key', API_KEY);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    const res = await fetch(url.toString());
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Drive API ${res.status}: ${text}`);
    }
    return res.json();
  }

  async function listAllChildren(folderId) {
    const all = [];
    let pageToken = null;
    do {
      const params = {
        q: `'${folderId}' in parents and trashed=false`,
        fields: 'nextPageToken, files(id,name,mimeType,modifiedTime,size)',
        pageSize: '1000',
        orderBy: 'name',
      };
      if (pageToken) params.pageToken = pageToken;
      const resp = await driveList(params);
      all.push(...(resp.files || []));
      pageToken = resp.nextPageToken;
    } while (pageToken);
    return all;
  }

  function isAudio(file) {
    if (file.mimeType && file.mimeType.startsWith('audio/')) return true;
    const name = (file.name || '').toLowerCase();
    return name.endsWith('.mp3') || name.endsWith('.m4a') || name.endsWith('.m4b')
        || name.endsWith('.wav') || name.endsWith('.ogg') || name.endsWith('.flac')
        || name.endsWith('.aac');
  }
  function isFolder(file) {
    return file.mimeType === 'application/vnd.google-apps.folder';
  }

  async function buildLibrary() {
    const rootChildren = await listAllChildren(ROOT_FOLDER_ID);
    const subfolders = rootChildren.filter(isFolder);
    const rootAudio = rootChildren.filter(isAudio);

    const albums = [];
    if (rootAudio.length) {
      albums.push(makeAlbum('__root__', 'Loose tracks', rootAudio));
    }
    // Crawl subfolders in parallel (one nested level deeper too)
    const albumResults = await Promise.all(
      subfolders.map(async (folder) => {
        try {
          const files = await listAllChildren(folder.id);
          const direct = files.filter(isAudio);
          const nested = files.filter(isFolder);
          let extra = [];
          if (nested.length) {
            const nestedFiles = await Promise.all(
              nested.map((nf) =>
                listAllChildren(nf.id)
                  .then((arr) => arr.filter(isAudio))
                  .catch(() => [])
              )
            );
            extra = nestedFiles.flat();
          }
          const tracks = [...direct, ...extra];
          if (!tracks.length) return null;
          return makeAlbum(folder.id, folder.name, tracks);
        } catch (e) {
          console.warn('Failed to read folder', folder.name, e);
          return null;
        }
      })
    );
    albumResults.filter(Boolean).forEach((a) => albums.push(a));
    albums.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

    const flatTracks = [];
    const trackById = {};
    for (const a of albums) {
      for (const t of a.tracks) {
        flatTracks.push(t);
        trackById[t.id] = t;
      }
    }
    return { albums, flatTracks, trackById, updatedAt: Date.now() };
  }

  function makeAlbum(id, name, files) {
    const tracks = files.map((f) => ({
      id: f.id,
      name: cleanTrackName(f.name),
      rawName: f.name,
      albumId: id,
      albumName: name,
      mimeType: f.mimeType,
      modifiedTime: f.modifiedTime,
      size: f.size,
    }));
    tracks.sort((a, b) => naturalCompare(a.name, b.name));
    return { id, name, tracks };
  }
  function cleanTrackName(filename) {
    return filename.replace(/\.[a-zA-Z0-9]+$/, '').replace(/_/g, ' ').trim();
  }
  function naturalCompare(a, b) {
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
  }

  // ============== STREAM URL ==============
  // The /uc?export=download endpoint is the simplest path for streaming public
  // mp3s into an HTMLAudioElement. It follows 302s to googleusercontent.com
  // and supports range requests, so scrubbing works. The official
  // drive.v3/files/{id}?alt=media endpoint requires CORS on the audio
  // element which adds complexity for browser playback; the uc endpoint
  // works without it since we're not reading the bytes ourselves.
  function streamUrl(fileId) {
    // Official Drive API media endpoint. Serves raw bytes (not HTML pages),
    // supports HTTP Range requests for seeking, returns proper CORS headers,
    // and bypasses the virus-scan interstitial entirely.
    return `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&key=${encodeURIComponent(API_KEY)}`;
  }

  // ============== OFFLINE DOWNLOADS ==============
  // Available on iOS & Android only (hidden on web). Uses IndexedDB to store
  // audio blobs locally so playback works without a network connection.

  const _DL_DB   = 'mysanskar-dl';
  const _DL_STORE = 'blobs';
  let   _dlDb     = null;
  const _dlState  = {};    // fileId → 'downloading' | 'done'
  const _dlUrls   = {};    // fileId → blob URL (session-scoped)
  const _dlCbs    = {};    // fileId → [callback] waiting for blob URL

  function isNative() {
    return !!(window.Capacitor?.isNativePlatform?.());
  }

  function openDlDb() {
    if (_dlDb) return Promise.resolve(_dlDb);
    return new Promise((res, rej) => {
      const req = indexedDB.open(_DL_DB, 1);
      req.onupgradeneeded = e => {
        if (!e.target.result.objectStoreNames.contains(_DL_STORE))
          e.target.result.createObjectStore(_DL_STORE);
      };
      req.onsuccess = e => { _dlDb = e.target.result; res(_dlDb); };
      req.onerror   = () => rej(req.error);
    });
  }

  async function dlGet(fileId) {
    const db = await openDlDb();
    return new Promise(res => {
      const tx = db.transaction(_DL_STORE, 'readonly');
      const r  = tx.objectStore(_DL_STORE).get(fileId);
      r.onsuccess = () => res(r.result || null);
      r.onerror   = () => res(null);
    });
  }

  async function dlPut(fileId, blob) {
    const db = await openDlDb();
    return new Promise((res, rej) => {
      const tx = db.transaction(_DL_STORE, 'readwrite');
      tx.objectStore(_DL_STORE).put(blob, fileId);
      tx.oncomplete = res;
      tx.onerror    = () => rej(tx.error);
    });
  }

  async function dlRemove(fileId) {
    const db = await openDlDb();
    return new Promise(res => {
      const tx = db.transaction(_DL_STORE, 'readwrite');
      tx.objectStore(_DL_STORE).delete(fileId);
      tx.oncomplete = res;
      tx.onerror    = res;
    });
  }

  async function dlKeys() {
    const db = await openDlDb();
    return new Promise(res => {
      const tx = db.transaction(_DL_STORE, 'readonly');
      const r  = tx.objectStore(_DL_STORE).getAllKeys();
      r.onsuccess = () => res(r.result || []);
      r.onerror   = () => res([]);
    });
  }

  // Called at startup — restores blob URLs for previously downloaded files.
  async function initDownloads() {
    if (!isNative()) return;
    try {
      const keys = await dlKeys();
      for (const k of keys) {
        _dlState[k] = 'done';
        // Create blob URLs eagerly so audioSrc() is synchronous at play time
        dlGet(k).then(blob => {
          if (blob) _dlUrls[k] = URL.createObjectURL(blob);
        });
      }
    } catch {}
  }

  function isDownloaded(fileId) { return _dlState[fileId] === 'done'; }

  // Synchronous — returns blob URL if ready, stream URL as fallback.
  function audioSrc(fileId) {
    return _dlUrls[fileId] || streamUrl(fileId);
  }

  // Download a file with progress callback (0–1). Resolves to blob URL.
  async function downloadFile(fileId, onProgress) {
    if (_dlState[fileId] === 'done') return _dlUrls[fileId] || streamUrl(fileId);
    if (_dlState[fileId] === 'downloading') {
      return new Promise((res, rej) => {
        (_dlCbs[fileId] = _dlCbs[fileId] || []).push({ res, rej });
      });
    }
    _dlState[fileId] = 'downloading';
    try {
      const resp = await fetch(streamUrl(fileId));
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const total  = parseInt(resp.headers.get('content-length') || '0');
      const reader = resp.body.getReader();
      const chunks = [];
      let loaded = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.length;
        if (total && onProgress) onProgress(loaded / total);
      }
      const blob   = new Blob(chunks, { type: 'audio/mpeg' });
      await dlPut(fileId, blob);
      const url    = URL.createObjectURL(blob);
      _dlUrls[fileId]  = url;
      _dlState[fileId] = 'done';
      (_dlCbs[fileId] || []).forEach(c => c.res(url));
      delete _dlCbs[fileId];
      return url;
    } catch (e) {
      delete _dlState[fileId];
      (_dlCbs[fileId] || []).forEach(c => c.rej(e));
      delete _dlCbs[fileId];
      throw e;
    }
  }

  async function removeDownload(fileId) {
    await dlRemove(fileId);
    delete _dlState[fileId];
    if (_dlUrls[fileId]) { URL.revokeObjectURL(_dlUrls[fileId]); delete _dlUrls[fileId]; }
  }

  // Resolve a human-friendly name for a downloaded fileId. Downloads can be either
  // music tracks (keyed in state.trackById) or audiobook chapters (a chapter id
  // inside _abLibrary). Falls back to the raw id only if nothing matches.
  function dlDisplayName(fileId) {
    const track = state.trackById[fileId];
    if (track) {
      return track.albumName ? `${track.name} · ${track.albumName}` : track.name;
    }
    if (_abLibrary && _abLibrary.books) {
      for (const book of _abLibrary.books) {
        const ch = book.chapters.find(c => c.id === fileId);
        if (ch) {
          // Single-file books: the chapter IS the book — just show the book name.
          return book.chapters.length === 1 ? book.name : `${book.name} · ${ch.name}`;
        }
      }
    }
    return fileId;
  }

  function renderDlSettingsSection() {
    const list    = $('settings-dl-list');
    const clearBtn = $('settings-dl-clear-btn');
    if (!list) return;
    const downloaded = Object.keys(_dlState).filter(k => _dlState[k] === 'done');
    if (!downloaded.length) {
      list.innerHTML = '<div class="settings-dl-empty">No offline downloads yet. Use the ⋯ menu on any track to download it.</div>';
      if (clearBtn) clearBtn.classList.add('hidden');
      return;
    }
    if (clearBtn) clearBtn.classList.remove('hidden');

    // Ensure the audiobook library is loaded so chapter ids resolve to book names,
    // then re-render once it arrives.
    if (!_abLibrary) {
      loadAudiobookLibrary().then(() => renderDlSettingsSection()).catch(() => {});
    }

    list.innerHTML = '';
    downloaded.forEach(fileId => {
      const name = dlDisplayName(fileId);
      const row = document.createElement('div');
      row.className = 'settings-dl-row';
      row.innerHTML = `
        <span class="dl-dot"></span>
        <span class="settings-dl-name">${escapeHtml(name)}</span>
        <button class="settings-dl-remove" aria-label="Remove">✕</button>`;
      row.querySelector('.settings-dl-remove').addEventListener('click', async () => {
        await removeDownload(fileId);
        renderDlSettingsSection();
        renderLibrary();
        toast('Download removed');
      });
      list.appendChild(row);
    });
  }

  // ============== LIBRARY BOOTSTRAP ==============
  async function bootstrapLibrary() {
    // Try cache first for instant render
    let renderedFromCache = false;
    try {
      const cached = JSON.parse(localStorage.getItem(LS.library) || 'null');
      if (cached && cached.albums && cached.albums.length) {
        applyLibrary(cached);
        renderLibrary();
        $('library-sub').textContent = 'Refreshing…';
        renderedFromCache = true;
      }
    } catch {}

    if (!renderedFromCache) {
      $('library-sub').textContent = 'Loading…';
    }

    // Wrap buildLibrary in a 12-second timeout so slow/offline iOS doesn't hang forever
    try {
      const fresh = await Promise.race([
        buildLibrary(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Library load timed out')), 12000)),
      ]);
      applyLibrary(fresh);
      try {
        localStorage.setItem(LS.library, JSON.stringify({ albums: fresh.albums, updatedAt: fresh.updatedAt }));
      } catch {}
      renderLibrary();
      $('library-sub').textContent = `${state.library.albums.length} albums · ${state.flatTracks.length} songs`;
    } catch (e) {
      console.error(e);
      if (!state.library) {
        toast('Could not load library. Check your connection.');
        $('library-sub').textContent = 'Library failed to load.';
      } else {
        $('library-sub').textContent = `${state.library.albums.length} albums · ${state.flatTracks.length} songs`;
      }
    }
  }

  function applyLibrary(lib) {
    state.library = lib;
    state.flatTracks = [];
    state.trackById = {};
    for (const a of lib.albums) {
      for (const t of a.tracks) {
        state.flatTracks.push(t);
        state.trackById[t.id] = t;
      }
    }
    // Reattach last track's metadata if still present
    if (state.currentTrackId && state.trackById[state.currentTrackId]) {
      updateNowPlayingUI(state.trackById[state.currentTrackId], true);
    }
  }

  // ============== COLOR HASHING ==============
  function hashStr(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return Math.abs(h);
  }
  const PALETTES = [
    ['#2a4030', '#0f1f17'],
    ['#3a2b4a', '#1a1224'],
    ['#4a2f2a', '#211513'],
    ['#2f3a4a', '#141a22'],
    ['#4a4030', '#211a12'],
    ['#2a3f4a', '#13202a'],
    ['#4a2a3f', '#221324'],
    ['#3a4a2a', '#1c241a'],
    ['#2a4a4a', '#132424'],
    ['#4a2a2a', '#241313'],
    ['#2a2a4a', '#13132a'],
    ['#404a2a', '#22241a'],
  ];
  function paletteFor(name) {
    return PALETTES[hashStr(name || '?') % PALETTES.length];
  }
  function applyArt(el, name) {
    if (!el) return;
    const [a, b] = paletteFor(name || '?');
    el.style.setProperty('--c-a', a);
    el.style.setProperty('--c-b', b);
  }

  // ============== RENDER: LIBRARY ==============
  const LIST_ICON = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>`;
  const GRID_ICON = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>`;

  function updateViewToggleIcon() {
    const btn = $('view-toggle-btn');
    if (btn) btn.innerHTML = state.libraryView === 'list' ? GRID_ICON : LIST_ICON;
  }

  function renderLibrary() {
    if (!state.library) return;
    const list = $('folders-list');
    list.innerHTML = '';
    list.className = state.libraryView === 'list' ? 'folders-list list-view' : 'folders-list';
    updateViewToggleIcon();
    if (!state.library.albums.length) {
      list.innerHTML = `<div class="empty-state"><h3>No music found</h3><p>Drop MP3s into your Drive folder and hit refresh.</p></div>`;
      return;
    }
    // Pinned "Downloaded" collection — gathers every offline track in one place
    // so it's easy to see and manage what's saved. Native only, shown when there's
    // at least one download.
    if (isNative()) {
      const dlTracks = downloadedTracks();
      if (dlTracks.length) {
        const dlCard = document.createElement('div');
        dlCard.className = 'folder-card folder-card-downloads';
        dlCard.innerHTML = `
          <div class="folder-art folder-art-downloads">
            <svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          </div>
          <p class="folder-name">Downloaded</p>
          <p class="folder-meta">${dlTracks.length} song${dlTracks.length === 1 ? '' : 's'} · offline</p>
        `;
        dlCard.addEventListener('click', openDownloadsAlbum);
        list.appendChild(dlCard);
      }
    }

    for (const a of state.library.albums) {
      const card = document.createElement('div');
      card.className = 'folder-card';
      const initial = (a.name || '?').trim().charAt(0).toUpperCase();
      card.innerHTML = `
        <div class="folder-art">
          <span class="folder-initial">${escapeHtml(initial)}</span>
        </div>
        <p class="folder-name">${escapeHtml(a.name)}</p>
        <p class="folder-meta">${a.tracks.length} song${a.tracks.length === 1 ? '' : 's'}</p>
      `;
      applyArt(card.querySelector('.folder-art'), a.name);
      card.addEventListener('click', () => openAlbum(a.id));
      list.appendChild(card);
    }
  }

  // ============== RENDER: ALBUM ==============
  function openAlbum(albumId) {
    const album = state.library.albums.find((a) => a.id === albumId);
    if (!album) return;
    state.activeAlbum = album;
    switchView('view-album');
    $('album-title').textContent = album.name;
    $('album-count').textContent = `${album.tracks.length} song${album.tracks.length === 1 ? '' : 's'}`;
    const list = $('album-tracks');
    list.innerHTML = '';
    album.tracks.forEach((t, idx) => list.appendChild(renderTrackRow(t, idx + 1, 'album')));
    $('content').scrollTo({ top: 0, behavior: 'instant' });
  }

  // Every music track currently saved offline, in library order.
  function downloadedTracks() {
    if (!state.library) return [];
    const out = [];
    for (const a of state.library.albums) {
      for (const t of a.tracks) {
        if (isDownloaded(t.id)) out.push(t);
      }
    }
    return out;
  }

  // Virtual "Downloaded" album listing all offline tracks. Reuses the album view.
  function openDownloadsAlbum() {
    const tracks = downloadedTracks();
    state.activeAlbum = { id: '__downloads__', name: 'Downloaded', tracks };
    switchView('view-album');
    $('album-title').textContent = 'Downloaded';
    $('album-count').textContent = `${tracks.length} song${tracks.length === 1 ? '' : 's'} · available offline`;
    const list = $('album-tracks');
    list.innerHTML = '';
    if (!tracks.length) {
      list.innerHTML = `<div class="empty-state"><h3>No downloads</h3><p>Use the ⋯ menu on any song to save it for offline.</p></div>`;
    } else {
      tracks.forEach((t, idx) => list.appendChild(renderTrackRow(t, idx + 1, 'downloads')));
    }
    $('content').scrollTo({ top: 0, behavior: 'instant' });
  }

  function renderTrackRow(track, num, context) {
    const row = document.createElement('div');
    row.className = 'track-row';
    row.dataset.trackId = track.id;
    row.dataset.context = context || '';
    if (state.currentTrackId === track.id) row.classList.add('playing');
    const isPlaying = state.currentTrackId === track.id && state.playing;
    const hideNum = context === 'queue-current';
    let numHtml;
    if (isPlaying) {
      numHtml = `<div class="track-num"><span class="playing-bars"><span></span><span></span><span></span></span></div>`;
    } else if (hideNum) {
      numHtml = `<div class="track-num"></div>`;
    } else {
      numHtml = `<div class="track-num show-on-hover">${num}</div>`;
    }
    const playCount = state.playCounts[track.id] || 0;
    const countHtml = playCount > 0
      ? `<span class="track-play-count" title="${playCount} play${playCount === 1 ? '' : 's'}">${playCount}×</span>`
      : '';
    row.innerHTML = `
      ${numHtml}
      <div class="track-info">
        <p class="track-title">${escapeHtml(track.name)}</p>
        <p class="track-sub">${escapeHtml(track.albumName)}</p>
      </div>
      <div class="track-actions">
        ${countHtml}
        ${isNative() && isDownloaded(track.id) ? `<span class="dl-dot" title="Downloaded"></span>` : ''}
        <button class="track-more" aria-label="More options">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
            <circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/>
          </svg>
        </button>
      </div>
    `;
    row.addEventListener('click', (e) => {
      if (e.target.closest('.track-more')) return;
      playFromContext(track.id, context);
    });
    row.querySelector('.track-more').addEventListener('click', (e) => {
      e.stopPropagation();
      openTrackMenu(track.id, context);
    });
    return row;
  }

  // ============== AUDIO SETUP ==============
  function setupAudio() {
    audio.addEventListener('play', () => {
      state.playing = true;
      updatePlayIcon(); updateMediaSession(); refreshPlayingIndicators();
      // Pause audiobook when music starts
      if (_abAudio && !_abAudio.paused) abPause();
    });
    audio.addEventListener('pause', () => { state.playing = false; updatePlayIcon(); updateMediaSession(); refreshPlayingIndicators(); });
    audio.addEventListener('ended', handleTrackEnded);
    audio.addEventListener('timeupdate', updateProgress);
    audio.addEventListener('loadedmetadata', updateDuration);
    audio.addEventListener('error', () => {
      console.warn('audio error', audio.error);
      const t = state.trackById[state.currentTrackId];
      if (t) toast(`Couldn't play "${t.name}"`);
    });
    audio.loop = state.loop;

    if ('mediaSession' in navigator) {
      navigator.mediaSession.setActionHandler('play', () => togglePlay());
      navigator.mediaSession.setActionHandler('pause', () => togglePlay());
      navigator.mediaSession.setActionHandler('previoustrack', () => prev());
      navigator.mediaSession.setActionHandler('nexttrack', () => next());
    }
  }

  function playTrack(trackId, opts = {}) {
    const t = state.trackById[trackId];
    if (!t) return;
    if (state.currentTrackId && state.currentTrackId !== trackId && !opts.noHistory) {
      state.history.push(state.currentTrackId);
      if (state.history.length > 200) state.history.shift();
    }
    state.currentTrackId = trackId;
    persist('lastTrack');
    state.playCounts[trackId] = (state.playCounts[trackId] || 0) + 1;
    persist('playCounts');
    syncPlayCountToFirestore(trackId);
    audio.src = audioSrc(trackId);
    audio.play().catch((e) => { console.warn('play() rejected', e); });
    updateNowPlayingUI(t, true);
    refreshPlayingIndicators();
  }

  function playFromContext(trackId, context) {
    if (context === 'downloads') {
      state.currentSource = { kind: 'downloads', payload: null };
    } else if (context === 'album' && state.activeAlbum) {
      state.currentSource = { kind: 'album', payload: state.activeAlbum.id };
    } else if (context === 'playlist' && state.activePlaylist) {
      state.currentSource = { kind: 'playlist', payload: state.activePlaylist.id };
    } else if (context === 'queue') {
      // playing a track from the queue pane: pop everything before it
      state.currentSource = { kind: 'queue', payload: null };
      const idx = state.queue.indexOf(trackId);
      if (idx >= 0) state.queue = state.queue.slice(idx + 1);
      persist('queue');
    } else {
      state.currentSource = { kind: 'single', payload: null };
    }
    playTrack(trackId);
    if (state.currentTab === 'queue') renderQueue();
  }

  function getSourceTracks() {
    const src = state.currentSource;
    if (!src || src.kind === 'none' || src.kind === 'single' || src.kind === 'queue') return null;
    if (src.kind === 'downloads') {
      return downloadedTracks().map((t) => t.id);
    }
    if (src.kind === 'album') {
      const a = state.library?.albums.find((al) => al.id === src.payload);
      return a ? a.tracks.map((t) => t.id) : null;
    }
    if (src.kind === 'playlist') {
      const p = state.playlists.find((pl) => pl.id === src.payload);
      return p ? p.trackIds.filter((id) => state.trackById[id]) : null;
    }
    return null;
  }

  function handleTrackEnded() {
    if (state.loop) {
      audio.currentTime = 0;
      audio.play();
      return;
    }
    next(true);
  }

  function next(auto = false) {
    // Queue always wins
    if (state.queue.length) {
      const nextId = state.queue.shift();
      persist('queue');
      playTrack(nextId);
      if (state.currentTab === 'queue') renderQueue();
      return;
    }
    const ids = getSourceTracks();
    if (ids && ids.length) {
      const i = ids.indexOf(state.currentTrackId);
      let nextIdx;
      if (state.shuffle) {
        if (ids.length === 1) nextIdx = 0;
        else { do { nextIdx = Math.floor(Math.random() * ids.length); } while (nextIdx === i); }
      } else {
        nextIdx = i + 1;
      }
      if (nextIdx >= 0 && nextIdx < ids.length) {
        playTrack(ids[nextIdx]);
        return;
      }
    }
    if (auto) {
      state.playing = false;
      updatePlayIcon();
    } else {
      audio.currentTime = 0;
    }
  }

  function prev() {
    if (audio.currentTime > 3) {
      audio.currentTime = 0;
      return;
    }
    if (state.history.length) {
      const id = state.history.pop();
      playTrack(id, { noHistory: true });
      return;
    }
    const ids = getSourceTracks();
    if (ids && ids.length) {
      const i = ids.indexOf(state.currentTrackId);
      if (i > 0) { playTrack(ids[i - 1], { noHistory: true }); return; }
    }
    audio.currentTime = 0;
  }

  function skip(seconds) {
    if (!audio.duration || isNaN(audio.duration)) return;
    audio.currentTime = Math.max(0, Math.min(audio.duration, audio.currentTime + seconds));
  }

  function togglePlay() {
    if (!state.currentTrackId) {
      if (state.flatTracks.length) {
        state.currentSource = { kind: 'single', payload: null };
        playTrack(state.flatTracks[0].id);
      }
      return;
    }
    // Restored from previous session — audio.src not yet loaded
    if (!audio.src && state.trackById[state.currentTrackId]) {
      playTrack(state.currentTrackId, { noHistory: true });
      return;
    }
    if (audio.paused) audio.play().catch(() => {});
    else audio.pause();
  }

  // ============== PLAY ALBUM / PLAYLIST ==============
  function playAlbum(albumId, shuffle = false) {
    const album = state.library.albums.find((a) => a.id === albumId);
    if (!album || !album.tracks.length) return;
    state.activeAlbum = album;
    state.shuffle = shuffle;
    persist('shuffle');
    state.currentSource = { kind: 'album', payload: albumId };
    const first = shuffle
      ? album.tracks[Math.floor(Math.random() * album.tracks.length)].id
      : album.tracks[0].id;
    playTrack(first);
    updateShuffleUI();
  }

  function playPlaylist(playlistId, shuffle = false) {
    const p = state.playlists.find((pl) => pl.id === playlistId);
    if (!p) return;
    const ids = p.trackIds.filter((id) => state.trackById[id]);
    if (!ids.length) { toast('Playlist is empty'); return; }
    state.activePlaylist = p;
    state.shuffle = shuffle;
    persist('shuffle');
    state.currentSource = { kind: 'playlist', payload: playlistId };
    const first = shuffle ? ids[Math.floor(Math.random() * ids.length)] : ids[0];
    playTrack(first);
    updateShuffleUI();
  }

  // ============== NOW PLAYING UI ==============
  // ── Lyrics sheet ──────────────────────────────────────
  // ── Lyrics (Firestore-backed) ──────────────────────────
  const _lyricsCache = {};  // normalizedKey → data object | null

  function normalizeLyricsKey(name) {
    return name.replace(/\.[^.]+$/, '').toLowerCase().trim().replace(/\s+/g, ' ');
  }

  async function fetchLyricsForTrack(trackName) {
    const key = normalizeLyricsKey(trackName);
    if (key in _lyricsCache) return _lyricsCache[key];
    try {
      const doc = await window.fbDb.collection('songLyrics').doc(key).get();
      _lyricsCache[key] = doc.exists ? doc.data() : null;
    } catch (e) {
      _lyricsCache[key] = null;
    }
    return _lyricsCache[key];
  }

  async function openLyricsSheet(track) {
    const lyrics = await fetchLyricsForTrack(track.name);
    if (!lyrics) return;

    $('lyrics-sheet-title').textContent = lyrics.songName || track.name.replace(/\.[^.]+$/, '');
    $('lyrics-sheet-lang').textContent = lyrics.language || '';

    const body = $('lyrics-sheet-body');
    body.innerHTML = '';
    const rawLines = (lyrics.lines || '').split('\n');
    rawLines.forEach(line => {
      if (line.trim() === '') {
        const spacer = document.createElement('div');
        spacer.style.height = '14px';
        body.appendChild(spacer);
        return;
      }
      const p = document.createElement('p');
      p.className = 'lyrics-line';
      p.textContent = line;
      body.appendChild(p);
    });

    $('lyrics-sheet').classList.remove('hidden');
    body.scrollTop = 0;
  }

  function closeLyricsSheet() {
    $('lyrics-sheet').classList.add('hidden');
  }

  function updateNowPlayingUI(track, resetTime = false) {
    if (!track) return;
    $('mini-title').textContent = track.name;
    $('mini-sub').textContent = track.albumName;
    $('sheet-title').textContent = track.name;
    $('sheet-sub').textContent = track.albumName;

    // Always hide lyrics btns first, then async-check Firestore
    const lyricsBtn     = $('sheet-lyrics-btn');
    const miniLyricsBtn = $('mini-lyrics-btn');
    if (lyricsBtn)     lyricsBtn.classList.add('hidden');
    if (miniLyricsBtn) miniLyricsBtn.classList.add('hidden');
    const trackIdAtLoad = track.id;
    fetchLyricsForTrack(track.name).then(lyrics => {
      // Only update if the same track is still active
      if (state.currentTrackId === trackIdAtLoad) {
        if (lyricsBtn)     lyricsBtn.classList.toggle('hidden', !lyrics);
        if (miniLyricsBtn) miniLyricsBtn.classList.toggle('hidden', !lyrics);
      }
    });
    const initial = (track.albumName || '?').charAt(0).toUpperCase();
    applyArt($('mini-art'), track.albumName);
    applyArt($('sheet-art'), track.albumName);
    $('sheet-art').innerHTML = `<span class="folder-initial">${escapeHtml(initial)}</span>`;
    const [a] = paletteFor(track.albumName || '?');
    document.querySelector('.player-sheet')?.style.setProperty('--c-a', a);
    // Only surface the mini-player on the music tab
    if (state.currentTab === 'music') {
      $('mini-player').classList.remove('hidden');
      $('content').classList.add('mini-visible');
    }
    if (resetTime) {
      $('sheet-current-time').textContent = '0:00';
      $('sheet-duration').textContent = '0:00';
      const seek = $('sheet-seek');
      seek.value = 0;
      seek.style.setProperty('--seek-pct', '0%');
      $('mini-current-time').textContent = '0:00';
      $('mini-duration-time').textContent = '0:00';
      const miniSeek = $('mini-seek');
      miniSeek.value = 0;
      miniSeek.style.setProperty('--seek-pct', '0%');
    }
    updatePlayIcon();
  }

  function updatePlayIcon() {
    const paused = !state.playing;
    const playSvg = '<polygon points="6 4 20 12 6 20 6 4"/>';
    const pauseSvg = '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>';
    const m = $('mini-play-icon');
    const s = $('sheet-play-icon');
    if (m) m.innerHTML = paused ? playSvg : pauseSvg;
    if (s) s.innerHTML = paused ? playSvg : pauseSvg;
  }

  function updateProgress() {
    if (!audio.duration || isNaN(audio.duration)) return;
    const pct = (audio.currentTime / audio.duration) * 100;
    // Sheet seek
    const seek = $('sheet-seek');
    if (!seek.dataset.scrubbing) {
      seek.value = Math.round((audio.currentTime / audio.duration) * 1000);
      seek.style.setProperty('--seek-pct', pct + '%');
    }
    $('sheet-current-time').textContent = formatTime(audio.currentTime);
    // Mini seek
    const miniSeek = $('mini-seek');
    if (!miniSeek.dataset.scrubbing) {
      miniSeek.value = Math.round((audio.currentTime / audio.duration) * 1000);
      miniSeek.style.setProperty('--seek-pct', pct + '%');
    }
    $('mini-current-time').textContent = formatTime(audio.currentTime);
  }

  function updateDuration() {
    const dur = formatTime(audio.duration);
    $('sheet-duration').textContent = dur;
    $('mini-duration-time').textContent = dur;
  }

  function formatTime(s) {
    if (!s || isNaN(s)) return '0:00';
    s = Math.floor(s);
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${sec.toString().padStart(2, '0')}`;
  }

  function updateMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const t = state.trackById[state.currentTrackId];
    if (!t) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: t.name,
        artist: t.albumName,
        album: t.albumName,
      });
      navigator.mediaSession.playbackState = state.playing ? 'playing' : 'paused';
    } catch {}
  }

  function refreshPlayingIndicators() {
    // Re-render bars on visible track rows
    document.querySelectorAll('.track-row').forEach((row) => {
      const isThis = row.dataset.trackId === state.currentTrackId;
      row.classList.toggle('playing', isThis);
      const numEl = row.querySelector('.track-num');
      if (!numEl) return;
      const hideNum = row.dataset.context === 'queue-current';
      if (isThis && state.playing) {
        if (!numEl.querySelector('.playing-bars')) {
          numEl.innerHTML = `<span class="playing-bars"><span></span><span></span><span></span></span>`;
          numEl.classList.remove('show-on-hover');
        }
      } else {
        if (numEl.querySelector('.playing-bars') || numEl.textContent.trim() === '') {
          if (hideNum) {
            numEl.innerHTML = '';
            numEl.classList.remove('show-on-hover');
          } else {
            const siblings = Array.from(row.parentElement.children);
            numEl.textContent = String(siblings.indexOf(row) + 1);
            numEl.classList.add('show-on-hover');
          }
        }
      }
    });
  }

  // ============== LOOP / SHUFFLE TOGGLES ==============
  function toggleLoop() {
    state.loop = !state.loop;
    audio.loop = state.loop;
    persist('loop');
    updateLoopUI();
    toast(state.loop ? 'Loop on' : 'Loop off');
  }
  function updateLoopUI() {
    $('sheet-loop').classList.toggle('active', state.loop);
    const ml = $('mini-loop');
    if (ml) ml.classList.toggle('active', state.loop);
  }
  function toggleShuffle() {
    state.shuffle = !state.shuffle;
    persist('shuffle');
    updateShuffleUI();
    toast(state.shuffle ? 'Shuffle on' : 'Shuffle off');
  }
  function updateShuffleUI() {
    $('sheet-shuffle').classList.toggle('active', state.shuffle);
    const ms = $('mini-shuffle');
    if (ms) ms.classList.toggle('active', state.shuffle);
  }

  // ============== QUEUE ==============
  function addToQueue(trackId, position = 'end') {
    if (position === 'next') state.queue.unshift(trackId);
    else state.queue.push(trackId);
    persist('queue');
    if (state.currentTab === 'queue') renderQueue();
  }
  function clearQueue() {
    state.queue = [];
    persist('queue');
    if (state.currentTab === 'queue') renderQueue();
  }
  function removeFromQueue(trackId) {
    const i = state.queue.indexOf(trackId);
    if (i >= 0) {
      state.queue.splice(i, 1);
      persist('queue');
      if (state.currentTab === 'queue') renderQueue();
    }
  }
  function renderQueue() {
    const cur = $('queue-current');
    const nxt = $('queue-next');
    cur.innerHTML = '';
    nxt.innerHTML = '';
    if (state.currentTrackId && state.trackById[state.currentTrackId]) {
      cur.appendChild(renderTrackRow(state.trackById[state.currentTrackId], 0, 'queue-current'));
    } else {
      cur.innerHTML = `<p class="queue-empty">Nothing playing.</p>`;
    }
    if (!state.queue.length) {
      nxt.innerHTML = `<p class="queue-empty">Queue is empty. Add songs from anywhere.</p>`;
    } else {
      state.queue.forEach((id, i) => {
        const t = state.trackById[id];
        if (!t) return;
        nxt.appendChild(renderTrackRow(t, i + 1, 'queue'));
      });
    }
  }

  // ============== PLAYLISTS ==============
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

  function createPlaylist(name) {
    const p = { id: uid(), name: (name || '').trim() || 'Untitled', trackIds: [], createdAt: Date.now() };
    state.playlists.unshift(p);
    persist('playlists');
    syncPlaylist(p);
    return p;
  }
  function deletePlaylist(id) {
    state.playlists = state.playlists.filter((p) => p.id !== id);
    persist('playlists');
    deletePlaylistFromFirestore(id);
  }
  function renamePlaylist(id, name) {
    const p = state.playlists.find((p) => p.id === id);
    if (p) { p.name = (name || '').trim() || p.name; persist('playlists'); syncPlaylist(p); }
  }
  function addToPlaylist(playlistId, trackId) {
    const p = state.playlists.find((p) => p.id === playlistId);
    if (!p) return false;
    if (p.trackIds.includes(trackId)) return false;
    p.trackIds.push(trackId);
    persist('playlists');
    syncPlaylist(p);
    return true;
  }
  function removeFromPlaylist(playlistId, trackId) {
    const p = state.playlists.find((p) => p.id === playlistId);
    if (!p) return;
    p.trackIds = p.trackIds.filter((id) => id !== trackId);
    persist('playlists');
    syncPlaylist(p);
  }

  function renderPlaylists() {
    const list = $('playlists-list');
    list.innerHTML = '';
    if (!state.playlists.length) {
      list.innerHTML = `<div class="empty-state"><h3>No playlists yet</h3><p>Tap "+ New" to create one.</p></div>`;
      return;
    }
    for (const p of state.playlists) {
      const card = document.createElement('div');
      card.className = 'playlist-card';
      card.innerHTML = `
        <div class="playlist-card-art">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15V6"/><path d="M18.5 18a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z"/><path d="M12 12H3"/><path d="M16 6H3"/><path d="M12 18H3"/></svg>
        </div>
        <div>
          <p class="playlist-card-name">${escapeHtml(p.name)}</p>
          <p class="playlist-card-meta">${p.trackIds.length} song${p.trackIds.length === 1 ? '' : 's'}</p>
        </div>
        <span></span>
      `;
      applyArt(card.querySelector('.playlist-card-art'), p.name);
      card.addEventListener('click', () => openPlaylist(p.id));
      list.appendChild(card);
    }
  }

  function openPlaylist(id) {
    const p = state.playlists.find((pl) => pl.id === id);
    if (!p) return;
    state.activePlaylist = p;
    switchView('view-playlist');
    $('playlist-title').textContent = p.name;
    const tracks = p.trackIds.map((tid) => state.trackById[tid]).filter(Boolean);
    $('playlist-count').textContent = `${tracks.length} song${tracks.length === 1 ? '' : 's'}`;
    applyArt($('playlist-cover'), p.name);
    const list = $('playlist-tracks');
    list.innerHTML = '';
    if (!tracks.length) {
      list.innerHTML = `<div class="empty-state"><h3>Empty playlist</h3><p>Add songs from the library.</p></div>`;
    } else {
      tracks.forEach((t, idx) => list.appendChild(renderTrackRow(t, idx + 1, 'playlist')));
    }
    $('content').scrollTo({ top: 0, behavior: 'instant' });
  }

  // ============== VIEW SWITCHING ==============
  function switchView(viewId) {
    document.querySelectorAll('#content .view').forEach((v) => v.classList.add('hidden'));
    $(viewId).classList.remove('hidden');
  }
  function switchMusicTab(subtab) {
    state.musicSubTab = subtab;
    try { localStorage.setItem(LS.activeMusicSubTab, subtab); } catch {}
    document.querySelectorAll('.music-subnav-btn').forEach((b) =>
      b.classList.toggle('active', b.dataset.subtab === subtab)
    );
    if (subtab === 'library') switchView('view-library');
    else if (subtab === 'playlists') { switchView('view-playlists'); renderPlaylists(); }
    else if (subtab === 'queue') { switchView('view-queue'); renderQueue(); }
    $('content').scrollTo({ top: 0, behavior: 'instant' });
  }

  function switchTab(tab, musicSubtab) {
    // Handle legacy calls like switchTab('library') / switchTab('queue') etc.
    if (tab === 'library' || tab === 'playlists' || tab === 'queue') {
      musicSubtab = tab;
      tab = 'music';
    }

    state.currentTab = tab;
    try { localStorage.setItem(LS.activeTab, tab); } catch {}
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));

    const musicSubnav = $('music-subnav');
    const miniPlayer  = $('mini-player');
    const content     = $('content');

    if (tab === 'home') {
      if (musicSubnav) musicSubnav.classList.add('hidden');
      if (miniPlayer)  miniPlayer.classList.add('hidden');
      content.classList.remove('mini-visible');
      switchView('view-home');
      renderHomeFeed();
      content.scrollTo({ top: 0, behavior: 'instant' });
    } else if (tab === 'music') {
      if (musicSubnav) musicSubnav.classList.remove('hidden');
      // Show mini-player only when a track is loaded
      if (miniPlayer && state.currentTrackId) {
        miniPlayer.classList.remove('hidden');
        content.classList.add('mini-visible');
      } else {
        content.classList.remove('mini-visible');
      }
      switchMusicTab(musicSubtab || state.musicSubTab);
    } else if (tab === 'stories') {
      if (musicSubnav) musicSubnav.classList.add('hidden');
      if (miniPlayer)  miniPlayer.classList.add('hidden');
      content.classList.remove('mini-visible');
      stopTTS();
      switchView('view-stories');
      renderStoryCategories();
      content.scrollTo({ top: 0, behavior: 'instant' });
    } else if (tab === 'audiobooks') {
      if (musicSubnav) musicSubnav.classList.add('hidden');
      if (miniPlayer)  miniPlayer.classList.add('hidden');
      content.classList.remove('mini-visible');
      switchView('view-audiobooks');
      renderAudiobookLibrary();
      content.scrollTo({ top: 0, behavior: 'instant' });
    }
  }

  // ============== HOME FEED ==============

  const EKADASHI_CACHE_KEY = 'drift.ekadashiCache';
  const EKADASHI_CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours

  function renderHomeFeed() {
    // Update date header
    const dateEl = $('home-date');
    if (dateEl) {
      const now = new Date();
      dateEl.textContent = now.toLocaleDateString('en-US', {
        weekday: 'long', month: 'long', day: 'numeric',
      });
    }
    loadEkadashiTile();

    // loadStoryOfDay() handles skeleton show/hide synchronously before its first
    // await, so there is no blank gap or flash — no pre-show needed here.
    loadStoryOfDay();
  }

  async function loadEkadashiTile() {
    // Try valid cache first (filter out past dates inline)
    try {
      const cached = JSON.parse(localStorage.getItem(EKADASHI_CACHE_KEY) || 'null');
      if (cached && Date.now() - cached.ts < EKADASHI_CACHE_TTL) {
        const todayMs = Date.UTC(...todayParts());
        const future  = (cached.data || []).filter((r) => {
          const [yr, mo, dy] = r.date.split('-').map(Number);
          return Date.UTC(yr, mo - 1, dy) >= todayMs;
        });
        if (future.length) {
          reattachDaysAway(future);
          showEkadashiTile(future[0]);
          return;
        }
      }
    } catch {}

    // Fetch from API — use absolute URL on native (Capacitor serves files locally,
    // so relative /api/* paths don't resolve to Vercel)
    const _ekadashiBase = (window.Capacitor && window.Capacitor.isNativePlatform?.())
      ? 'https://mysanskar.vercel.app'
      : '';
    try {
      const resp = await fetch(`${_ekadashiBase}/api/ekadashi`);
      if (!resp.ok) throw new Error(resp.status);
      const data = await resp.json();
      try { localStorage.setItem(EKADASHI_CACHE_KEY, JSON.stringify({ ts: Date.now(), data })); } catch {}
      if (data.length) showEkadashiTile(data[0]);
      else hideEkadashiTile();
    } catch {
      hideEkadashiTile();
    }
  }

  function showEkadashiTile(ekadashi) {
    const tile     = $('ekadashi-tile');
    const skeleton = $('ekadashi-skeleton');
    const nameEl   = $('ekadashi-name');
    const subEl    = $('ekadashi-sub');
    if (!tile || !nameEl || !subEl) return;

    if (skeleton) skeleton.classList.add('hidden');
    nameEl.textContent = ekadashi.name;

    const [yr, mo, dy] = ekadashi.date.split('-').map(Number);
    const dateLabel = new Date(yr, mo - 1, dy).toLocaleDateString('en-US', {
      month: 'long', day: 'numeric',
    });

    const typeLabel = ekadashi.fastType === 'Nirjala Upvas' ? 'Nirjala Upvas' : 'Fast';

    if (ekadashi.daysAway === 0) {
      subEl.textContent = `${typeLabel} • Today — ${dateLabel} 🙏`;
      subEl.classList.add('ekadashi-today');
    } else if (ekadashi.daysAway === 1) {
      subEl.textContent = `${typeLabel} • Tomorrow — ${dateLabel}`;
      subEl.classList.remove('ekadashi-today');
    } else {
      subEl.textContent = `${typeLabel} • In ${ekadashi.daysAway} days — ${dateLabel}`;
      subEl.classList.remove('ekadashi-today');
    }

    tile.classList.remove('hidden');
  }

  function hideEkadashiTile() {
    const tile     = $('ekadashi-tile');
    const skeleton = $('ekadashi-skeleton');
    if (tile)     tile.classList.add('hidden');
    if (skeleton) skeleton.classList.add('hidden');
  }

  function todayParts() {
    const n = new Date();
    return [n.getFullYear(), n.getMonth(), n.getDate()];
  }

  function reattachDaysAway(items) {
    const todayMs = Date.UTC(...todayParts());
    items.forEach((r) => {
      const [yr, mo, dy] = r.date.split('-').map(Number);
      r.daysAway = Math.round((Date.UTC(yr, mo - 1, dy) - todayMs) / 86400000);
    });
  }

  // ── Story of the Day ───────────────────────────────────────────────────────

  function sotdDateStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function sotdFirestoreRef(uid, dateStr) {
    return window.fbDb.collection(`users/${uid}/storyOfDay`).doc(dateStr);
  }

  async function loadStoryOfDay() {
    // Each call gets a unique ID. Any async step checks it before touching the DOM,
    // so a newer concurrent call (e.g. from syncChildProfileFromFirestore) cleanly
    // supersedes an older in-flight one — preventing two tiles showing at once.
    const myReqId = ++_sotdReqId;

    const tile       = $('sotd-tile');
    const skeleton   = $('sotd-skeleton');
    const setupTile  = $('sotd-setup-tile');

    // Guest mode: show a locked tile instead of generating a story
    if (isGuestMode()) {
      [tile, skeleton, setupTile].forEach((el) => el && el.classList.add('hidden'));
      const homeTiles = $('home-tiles');
      if (homeTiles && !$('sotd-guest-tile')) {
        const guestTile = document.createElement('div');
        guestTile.id        = 'sotd-guest-tile';
        guestTile.className = 'home-tile sotd-guest-tile';
        guestTile.innerHTML = `
          <div class="sotd-guest-tile-icon">📖</div>
          <div class="sotd-guest-tile-body">
            <div class="sotd-guest-tile-label">Today's Story</div>
            <div class="sotd-guest-tile-title">Story of the Day</div>
            <div class="sotd-guest-tile-sub">Create a free account to unlock →</div>
          </div>`;
        guestTile.addEventListener('click', () => promptGuestSignIn());
        // Insert after ekadashi tile
        const ekadashi = $('ekadashi-tile') || $('ekadashi-skeleton');
        if (ekadashi && ekadashi.nextSibling) {
          homeTiles.insertBefore(guestTile, ekadashi.nextSibling);
        } else {
          homeTiles.appendChild(guestTile);
        }
      }
      return;
    }

    // Remove the guest-mode locked tile if the user is now signed in
    const guestTile = $('sotd-guest-tile');
    if (guestTile) guestTile.remove();

    // Reset all SOTD tiles synchronously. The skeleton is immediately re-shown
    // below (before the first await), so there is no visible flash — the browser
    // doesn't repaint between synchronous statements in the same task.
    [tile, skeleton, setupTile].forEach((el) => el && el.classList.add('hidden'));

    if (!state.user) return;

    const profile   = getChildProfile();
    const character = buildChildCharacterString(profile);

    // No child configured — show welcoming prompt
    if (!character) {
      if (setupTile) {
        setupTile.classList.remove('hidden');
        setupTile.onclick = () => $('settings-btn').click();
      }
      return;
    }

    const key = (window.DRIFT_CONFIG || {}).geminiKey || '';
    if (!key) return;

    const dateStr = sotdDateStr();

    // Show skeleton immediately (synchronous — no repaint yet) with personalised text
    if (skeleton) {
      const childName = profile?.name ? profile.name.split(' ')[0] : '';
      const loadingTitle = $('sotd-loading-title');
      const loadingSub   = $('sotd-loading-sub');
      const funMessages  = childName ? [
        `Writing ${childName}'s story for today…`,
        `Crafting something special for ${childName}…`,
        `A brand new story is on its way for ${childName}…`,
        `Cooking up today's tale for ${childName}…`,
      ] : [
        'Writing today\'s story…',
        'Crafting something special…',
        'A brand new story is on its way…',
      ];
      const subs = [
        'This one\'s going to be great 🌟',
        'Jay Swaminarayan 🙏',
        'Almost ready…',
        'Weaving words with wisdom…',
      ];
      if (loadingTitle) loadingTitle.textContent = funMessages[Math.floor(Math.random() * funMessages.length)];
      if (loadingSub)   loadingSub.textContent   = subs[Math.floor(Math.random() * subs.length)];
      skeleton.classList.remove('hidden');
    }

    try {
      // 1. Check Firestore for today's story
      const doc = await sotdFirestoreRef(state.user.uid, dateStr).get();
      if (_sotdReqId !== myReqId) return; // superseded by a newer call — bail out silently

      if (doc.exists) {
        // Story already exists — swap skeleton → tile
        if (skeleton) skeleton.classList.add('hidden');
        const sotdStory = doc.data();
        showSOTDTile(sotdStory);
        // Cross-save to "Your Stories" (no-op if already there)
        saveAIStory(sotdStory);
        renderAISavedList();
        return;
      }

      // 2. Not in Firestore — keep skeleton visible while Gemini generates
      const loadingSub = $('sotd-loading-sub');
      if (loadingSub) loadingSub.textContent = 'Writing today\'s story…';

      const topic  = RANDOM_TOPICS[Math.floor(Math.random() * RANDOM_TOPICS.length)];
      const prompt = buildStoryPrompt(topic, character, 'medium');
      const result = await callGemini(key, prompt);
      if (_sotdReqId !== myReqId) return; // superseded while generating — bail out silently
      if (!result?.title || !result?.paragraphs?.length) throw new Error('bad response');

      const story = {
        id:          `sotd-${dateStr}`,
        date:        dateStr,
        title:       result.title,
        paragraphs:  result.paragraphs,
        topic,
        character,
        length:      'medium',
        generatedAt: Date.now(),
      };

      // 3. Persist to Firestore so subsequent opens are instant
      sotdFirestoreRef(state.user.uid, dateStr).set(story).catch(() => {});

      // 4. Cross-save to "Your Stories" so it appears in Stories tab
      saveAIStory(story);
      renderAISavedList();

      // 5. Swap skeleton → tile
      if (skeleton) skeleton.classList.add('hidden');
      showSOTDTile(story);

    } catch (e) {
      if (_sotdReqId !== myReqId) return;
      console.warn('[SOTD] generation failed:', e.message);
      if (skeleton) skeleton.classList.add('hidden');
      // Fail silently — home feed stays clean
    }
  }

  function showSOTDTile(story) {
    const tile    = $('sotd-tile');
    const titleEl = $('sotd-title');
    const subEl   = $('sotd-sub');
    if (!tile) return;

    if (titleEl) titleEl.textContent = story.title;
    if (subEl) {
      // Show a longer preview — CSS clamps to 4 lines visually
      const preview = (story.paragraphs?.[0] || '').trim();
      subEl.textContent = preview.length > 220 ? preview.slice(0, 217) + '…' : preview;
    }

    tile.classList.remove('hidden');
    tile.onclick = () => openSOTDStory(story);
  }

  function openSOTDStory(story) {
    state.currentStory = { ...story, type: 'text', photo: null, source: 'ai' };
    state.storyLang = 'en';
    stopTTS();

    setStoryHeroImage(story.imageUrl || null);

    const body = $('story-reader-body');
    body.innerHTML = '';

    const badge = document.createElement('div');
    badge.className = 'story-ai-badge';
    badge.innerHTML = `✨ Story of the Day · ${story.topic}`;
    body.appendChild(badge);

    story.paragraphs.forEach((p, i) => {
      const el = document.createElement('p');
      el.className = 'story-para';
      el.dataset.idx = i;
      el.textContent = p;
      body.appendChild(el);
    });

    renderMarkCompleteBtn(story.id);
    renderLangToggle(true);

    const ttsBar     = $('story-tts-bar');
    const voiceSheet = $('tts-voice-sheet');
    if (voiceSheet) voiceSheet.classList.add('hidden');

    const defaultLang = getDefaultStoryLang();
    if (ttsBar) ttsBar.classList.toggle('hidden', !isTTSAvailableForLang(defaultLang));

    renderStoryReaderTitle();
    if (defaultLang !== 'en') setStoryLang(defaultLang);

    // Back → return to home
    $('story-reader-back')._sotdMode = true;
    $('story-reader-back')._aiMode   = false;

    updateTTSUI();
    switchView('view-story-reader');
    $('content').scrollTo({ top: 0, behavior: 'instant' });

    // Generate cover image if not yet saved
    if (!story.imageUrl && !isImagenQuotaExhausted()) {
      setStoryHeroShimmer();

      generateImagenImage(story.topic, story.character, story.id).then((dataUrl) => {
        if (state.currentStory?.id !== story.id) return;
        setStoryHeroImage(dataUrl || null);
        if (dataUrl && state.user) {
          sotdFirestoreRef(state.user.uid, story.date)
            .update({ imageUrl: dataUrl }).catch(() => {});
        }
      });
    }
  }

  // ============== STORY TIME ==============

  function renderStoryCategories() {
    const data = window.STORIES_DATA;
    if (!data) return;
    const container = $('story-cats');
    if (!container) return;
    container.innerHTML = '';

    data.categories.forEach((cat) => {
      const stories = data.stories[cat.id] || [];
      const card = document.createElement('div');
      card.className = 'story-cat-card';
      card.style.background = `linear-gradient(135deg, ${cat.color[0]}, ${cat.color[1]})`;
      card.innerHTML = `
        <div class="story-cat-icon">${cat.icon}</div>
        <div class="story-cat-name">${cat.name}</div>
        <div class="story-cat-count">${stories.length} stories</div>
      `;
      card.addEventListener('click', () => openStoryCategory(cat.id));
      container.appendChild(card);
    });

    // Conversation Starters card
    if (window.CONVERSATION_STARTERS) {
      const convCard = document.createElement('div');
      convCard.className = 'story-cat-card';
      convCard.style.background = 'linear-gradient(135deg, #5B8FD6, #7B5EC8)';
      const totalCount = Object.values(window.CONVERSATION_STARTERS)
        .reduce((n, g) => n + g.categories.reduce((m, c) => m + c.items.length, 0), 0);
      convCard.innerHTML = `
        <div class="story-cat-icon">💬</div>
        <div class="story-cat-name">Conversation Starters</div>
        <div class="story-cat-count">${totalCount} prompts · 4 age groups</div>
        ${isGuestMode() ? '<div class="story-cat-lock-badge"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></div>' : ''}
      `;
      if (isGuestMode()) convCard.classList.add('story-cat-card--locked');
      convCard.addEventListener('click', () => {
        if (isGuestMode()) {
          toast('Sign up free to unlock Conversation Starters');
          return;
        }
        openConversationAges();
      });
      container.appendChild(convCard);
    }

    // AI Stories card
    const aiCard = document.createElement('div');
    aiCard.className = 'story-cat-card story-cat-ai';
    const aiSaved = loadAISavedStories();
    aiCard.innerHTML = `
      <div class="story-cat-icon">✨</div>
      <div class="story-cat-name">Make Your Own</div>
      <div class="story-cat-count">${aiSaved.length ? aiSaved.length + ' saved' : 'Generate new'}</div>
      ${isGuestMode() ? '<div class="story-cat-lock-badge"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></div>' : ''}
    `;
    if (isGuestMode()) aiCard.classList.add('story-cat-card--locked');
    aiCard.addEventListener('click', () => {
      if (isGuestMode()) {
        toast('Create a free account to make your own stories');
        return;
      }
      openAIStories();
    });
    container.appendChild(aiCard);
  }

  function openStoryCategory(catId) {
    const data = window.STORIES_DATA;
    if (!data) return;
    const cat = data.categories.find((c) => c.id === catId);
    if (!cat) return;
    state.currentCatId = catId;
    $('story-list-title').textContent = cat.name;
    $('story-search-input').value = '';
    $('story-search-clear').classList.add('hidden');
    // Hide search bar for guests — they only see the first 10 stories, no need to search
    const searchWrap = $('story-search-wrap');
    if (searchWrap) searchWrap.style.display = isGuestMode() ? 'none' : '';
    renderStoryList(catId, '');
    switchView('view-story-list');
    $('content').scrollTo({ top: 0, behavior: 'instant' });
  }

  function renderStoryList(catId, filter) {
    const data = window.STORIES_DATA;
    if (!data) return;
    let stories = data.stories[catId] || [];
    if (filter) {
      const q = filter.toLowerCase();
      stories = stories.filter((s) => s.title.toLowerCase().includes(q));
    }
    const container = $('story-list');
    if (!container) return;
    container.innerHTML = '';

    // Sync toggle UI
    document.querySelectorAll('.story-list-lang-btn').forEach((b) =>
      b.classList.toggle('active', b.dataset.lang === state.storyListLang)
    );

    if (!stories.length) {
      container.innerHTML = `<div class="empty-state"><h3>No stories found</h3><p>Try a different search.</p></div>`;
      return;
    }

    // Guest mode: show upsell banner + cap to GUEST_STORY_LIMIT for gated categories
    const isGuestCapped = isGuestMode() && GUEST_STORY_CATS.includes(catId) && !filter;
    const totalCount    = stories.length;
    if (isGuestCapped) {
      const bannerWrap = document.createElement('div');
      bannerWrap.className = 'guest-story-banner';
      bannerWrap.innerHTML = `
        <div class="guest-story-banner-text">
          Showing <strong>${Math.min(GUEST_STORY_LIMIT, totalCount)} of ${totalCount} stories</strong>.
          Create a free account to unlock all.
        </div>
        <button class="guest-story-banner-btn" id="guest-story-banner-cta">Sign up free</button>`;
      container.appendChild(bannerWrap);
      const ctaBtn = bannerWrap.querySelector('#guest-story-banner-cta');
      if (ctaBtn) ctaBtn.addEventListener('click', () => promptGuestSignIn());
      stories = stories.slice(0, GUEST_STORY_LIMIT);
    }

    stories.forEach((story) => {
      const row = document.createElement('div');
      row.className = 'story-row' + (isStoryCompleted(story.id) ? ' done' : '');
      const isVideo = story.type === 'youtube';

      // Use Gujarati title if toggled
      const titleTrans = window.STORY_TITLE_TRANSLATIONS && window.STORY_TITLE_TRANSLATIONS[story.id];
      const displayTitle = (state.storyListLang === 'gu' && titleTrans)
        ? titleTrans.gujarati
        : story.title;

      let thumbHtml;
      if (isVideo) {
        // YouTube thumbnail from their CDN
        thumbHtml = `<div class="story-row-thumb story-row-thumb--video">
          <img src="https://img.youtube.com/vi/${story.youtubeId}/mqdefault.jpg" alt="" loading="lazy" onerror="this.style.display='none'">
          <div class="story-row-play-badge">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><polygon points="6 4 20 12 6 20 6 4"/></svg>
          </div>
        </div>`;
      } else if (story.photo) {
        thumbHtml = `<div class="story-row-thumb"><img src="${story.photo}" alt="" loading="lazy" onerror="this.parentNode.textContent='📖'"></div>`;
      } else {
        thumbHtml = `<div class="story-row-thumb">📖</div>`;
      }

      row.innerHTML = `
        ${thumbHtml}
        <div class="story-row-info">
          <div class="story-row-title">${escapeHtml(displayTitle)}</div>
          ${isVideo ? `<div class="story-row-badge">Video</div>` : ''}
        </div>
        <svg class="story-row-arrow" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
      `;
      row.addEventListener('click', () => openStory(catId, story.id));
      container.appendChild(row);
    });
  }

  function openStory(catId, storyId) {
    const data = window.STORIES_DATA;
    if (!data) return;
    const story = (data.stories[catId] || []).find((s) => s.id === storyId);
    if (!story) return;
    state.currentStory = story;
    state.storyLang = 'en'; // always start as English so setStoryLang() below isn't a no-op
    stopTTS();

    // Header
    $('story-reader-title').textContent = story.title;

    const isVideo = story.type === 'youtube';
    const ttsBar = $('story-tts-bar');
    const voiceSheet = $('tts-voice-sheet');

    setStoryHeroImage(isVideo ? null : (story.photo || null));

    // Body
    const body = $('story-reader-body');
    body.innerHTML = '';

    if (isVideo) {
      const wrap = document.createElement('div');
      wrap.className = 'story-youtube-wrap';
      const _isNativeForYT = !!(window.Capacitor && window.Capacitor.isNativePlatform?.());
      if (_isNativeForYT) {
        // WKWebView blocks YouTube iframes (Error 153) — show a tap-to-open button instead
        const ytUrl = `https://www.youtube.com/watch?v=${story.youtubeId}`;
        wrap.innerHTML = `
          <div class="story-youtube-native" onclick="window.open('${ytUrl}','_system')">
            <img class="story-youtube-thumb"
              src="https://img.youtube.com/vi/${story.youtubeId}/mqdefault.jpg"
              alt="${escapeHtml(story.title)}" />
            <div class="story-youtube-play-overlay">
              <div class="story-youtube-play-btn">▶</div>
              <div class="story-youtube-play-label">Watch on YouTube</div>
            </div>
          </div>`;
      } else {
        wrap.innerHTML = `<iframe
          src="https://www.youtube.com/embed/${story.youtubeId}?rel=0&modestbranding=1"
          title="${escapeHtml(story.title)}"
          frameborder="0"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowfullscreen></iframe>`;
      }
      body.appendChild(wrap);
    }

    const hasParagraphs = story.paragraphs && story.paragraphs.length > 0;
    if (hasParagraphs) {
      // Always render English first so paragraphs exist in DOM
      story.paragraphs.forEach((p, i) => {
        const el = document.createElement('p');
        el.className = 'story-para';
        el.dataset.idx = i;
        el.textContent = p;
        body.appendChild(el);
      });
      renderMarkCompleteBtn(story.id);
    }

    // Language toggle — only for text (non-video) stories with paragraphs
    renderLangToggle(hasParagraphs && !isVideo);

    // TTS bar: available to all users for library stories (prerendered audio)
    const defaultLang = getDefaultStoryLang();
    if (ttsBar) ttsBar.classList.toggle('hidden', !hasParagraphs || !isTTSAvailableForLang(defaultLang));
    if (voiceSheet) voiceSheet.classList.add('hidden');

    // Render title (English initially; updated again after lang switch below)
    renderStoryReaderTitle();

    // Switch to the user's default language (no-op if 'en' since we already rendered English)
    if (hasParagraphs && !isVideo && defaultLang !== 'en') {
      setStoryLang(defaultLang);
    }

    // Back → return to story list (clear any residual mode flags from previous readers)
    $('story-reader-back')._sotdMode = false;
    $('story-reader-back')._aiMode   = false;

    updateTTSUI();
    switchView('view-story-reader');
    $('content').scrollTo({ top: 0, behavior: 'instant' });
  }

  // ============== CONVERSATION STARTERS ==============

  const CONV_AGE_COLORS = {
    newborn:  ['#6B8DD6', '#8E6AC8'],
    baby:     ['#E8A87C', '#D4766E'],
    toddler2: ['#5BBF8B', '#3A9E6E'],
    toddler3: ['#F5C842', '#E8973A'],
  };

  function openConversationAges() {
    const data = window.CONVERSATION_STARTERS;
    if (!data) return;
    const grid = $('conv-age-grid');
    if (!grid) return;
    grid.innerHTML = '';
    Object.entries(data).forEach(([key, group]) => {
      const colors = CONV_AGE_COLORS[key] || ['#7A8FA6', '#5A6F86'];
      const card = document.createElement('div');
      card.className = 'conv-age-card';
      card.style.background = `linear-gradient(135deg, ${colors[0]}, ${colors[1]})`;
      card.innerHTML = `
        <div class="conv-age-emoji">${group.emoji}</div>
        <div class="conv-age-label">${group.label}</div>
        <div class="conv-age-range">${group.ageRange}</div>
      `;
      card.addEventListener('click', () => openConversationStarters(key));
      grid.appendChild(card);
    });
    switchView('view-conv-ages');
    $('content').scrollTo({ top: 0, behavior: 'instant' });
  }

  let _convActiveAge = null;
  let _convActiveCat = 'all';
  let _convHideTalked = false;
  let _convTalkedSet = new Set();
  let _convTalkedSaveTimer = null;

  function convTalkedRef() {
    if (!state.user) return null;
    return window.fbDb.doc(`users/${state.user.uid}/settings/convStartersTalked`);
  }

  async function loadConvTalked() {
    if (!state.user) return;
    try {
      const doc = await convTalkedRef().get();
      if (doc.exists) {
        const { talked = [] } = doc.data();
        _convTalkedSet = new Set(talked);
      } else {
        _convTalkedSet = new Set();
      }
      // Refresh if the conv-starters view is currently open
      if ($('view-conv-starters') && !$('view-conv-starters').classList.contains('hidden') && _convActiveAge) {
        const group = window.CONVERSATION_STARTERS[_convActiveAge];
        if (group) {
          renderConvStarters(group, _convActiveCat);
          updateConvProgress(group);
        }
      }
    } catch (e) {
      console.warn('convTalked load failed', e);
    }
  }

  function saveConvTalked() {
    if (!state.user) return;
    clearTimeout(_convTalkedSaveTimer);
    _convTalkedSaveTimer = setTimeout(() => {
      convTalkedRef().set({ talked: [..._convTalkedSet] })
        .catch(e => console.warn('convTalked save failed', e));
    }, 600);
  }

  function convItemId(ageKey, catId, idx) {
    return `${ageKey}::${catId}::${idx}`;
  }

  function updateConvProgress(group) {
    const badge = $('conv-starters-progress');
    if (!badge || !group) return;
    let total = 0, done = 0;
    group.categories.forEach(cat => {
      cat.items.forEach((_, i) => {
        total++;
        if (_convTalkedSet.has(convItemId(_convActiveAge, cat.id, i))) done++;
      });
    });
    if (done === 0) {
      badge.classList.add('hidden');
    } else {
      badge.textContent = done === total ? `All ${total} done ✓` : `${done} / ${total} done`;
      badge.classList.remove('hidden');
    }
  }

  function openConversationStarters(ageKey) {
    const data = window.CONVERSATION_STARTERS;
    if (!data || !data[ageKey]) return;
    _convActiveAge = ageKey;
    _convActiveCat = 'all';
    _convHideTalked = false;
    const group = data[ageKey];
    $('conv-starters-title').textContent = `${group.emoji} ${group.label}`;
    $('conv-starters-sub').textContent = group.ageRange;
    const tipBar = $('conv-tip-bar');
    if (tipBar) tipBar.textContent = group.tip;
    renderConvCatPills(group);
    renderConvStarters(group, 'all');
    updateConvProgress(group);
    switchView('view-conv-starters');
    $('content').scrollTo({ top: 0, behavior: 'instant' });
  }

  function renderConvCatPills(group) {
    const scroll = $('conv-cat-scroll');
    if (!scroll) return;
    scroll.innerHTML = '';

    // Hide-done toggle pill (always first)
    const hideDoneBtn = document.createElement('button');
    hideDoneBtn.className = 'conv-cat-pill hide-done-pill' + (_convHideTalked ? ' active' : '');
    hideDoneBtn.textContent = _convHideTalked ? '✓ Hiding done' : '✓ Hide done';
    hideDoneBtn.addEventListener('click', () => {
      _convHideTalked = !_convHideTalked;
      hideDoneBtn.textContent = _convHideTalked ? '✓ Hiding done' : '✓ Hide done';
      hideDoneBtn.classList.toggle('active', _convHideTalked);
      renderConvStarters(group, _convActiveCat);
      $('content').scrollTo({ top: 0, behavior: 'instant' });
    });
    scroll.appendChild(hideDoneBtn);

    const allBtn = document.createElement('button');
    allBtn.className = 'conv-cat-pill active';
    allBtn.textContent = '✨ All';
    allBtn.addEventListener('click', () => {
      _convActiveCat = 'all';
      document.querySelectorAll('.conv-cat-pill:not(.hide-done-pill)').forEach(p => p.classList.remove('active'));
      allBtn.classList.add('active');
      renderConvStarters(group, 'all');
      $('content').scrollTo({ top: 0, behavior: 'instant' });
    });
    scroll.appendChild(allBtn);

    group.categories.forEach(cat => {
      const btn = document.createElement('button');
      btn.className = 'conv-cat-pill';
      btn.textContent = `${cat.emoji} ${cat.title}`;
      btn.dataset.catId = cat.id;
      btn.addEventListener('click', () => {
        _convActiveCat = cat.id;
        document.querySelectorAll('.conv-cat-pill:not(.hide-done-pill)').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        renderConvStarters(group, cat.id);
        $('content').scrollTo({ top: 0, behavior: 'instant' });
      });
      scroll.appendChild(btn);
    });
  }

  function renderConvStarters(group, catFilter) {
    const list = $('conv-starters-list');
    if (!list) return;
    list.innerHTML = '';
    const cats = catFilter === 'all' ? group.categories : group.categories.filter(c => c.id === catFilter);
    cats.forEach(cat => {
      // Count talked in this category
      const talkedCount = cat.items.filter((_, i) =>
        _convTalkedSet.has(convItemId(_convActiveAge, cat.id, i))
      ).length;

      if (catFilter === 'all') {
        const heading = document.createElement('div');
        heading.className = 'conv-cat-heading';
        const badgeHtml = talkedCount > 0
          ? `<span class="conv-cat-badge">${talkedCount === cat.items.length ? 'All done ✓' : `${talkedCount}/${cat.items.length}`}</span>`
          : '';
        heading.innerHTML = `${cat.emoji} ${cat.title}${badgeHtml}`;
        list.appendChild(heading);
      }

      // If hiding talked items and all are talked, show a soft empty state
      if (_convHideTalked && talkedCount === cat.items.length) {
        const done = document.createElement('div');
        done.className = 'conv-cat-all-done';
        done.textContent = 'All done! 🎉';
        list.appendChild(done);
        return;
      }

      cat.items.forEach((item, idx) => {
        const id = convItemId(_convActiveAge, cat.id, idx);
        const talked = _convTalkedSet.has(id);

        // Skip talked items when hide filter is on
        if (_convHideTalked && talked) return;

        const card = document.createElement('div');
        card.className = 'conv-starter-card' + (talked ? ' talked' : '');
        card.dataset.itemId = id;

        const enText = (item && typeof item === 'object') ? item.en : item;
        const translitText = (item && typeof item === 'object') ? item.translit : '';
        const translitHtml = translitText
          ? `<div class="conv-starter-translit">${translitText}</div>`
          : '';
        const checkMark = talked ? '✓' : '';

        card.innerHTML =
          `<div class="conv-starter-body">` +
            `<div class="conv-starter-en">${enText}</div>` +
            translitHtml +
          `</div>` +
          `<div class="conv-starter-check">${checkMark}</div>`;

        card.addEventListener('click', () => {
          const wasTalked = _convTalkedSet.has(id);
          if (wasTalked) {
            _convTalkedSet.delete(id);
          } else {
            _convTalkedSet.add(id);
          }
          saveConvTalked();
          updateConvProgress(group);

          if (_convHideTalked && !wasTalked) {
            // Item just got marked done — remove it with a quick fade
            card.style.transition = 'opacity 0.2s';
            card.style.opacity = '0';
            setTimeout(() => {
              renderConvStarters(group, catFilter);
            }, 200);
            return;
          }

          // Just toggle classes in-place (no full re-render)
          card.classList.toggle('talked', !wasTalked);
          const checkEl = card.querySelector('.conv-starter-check');
          if (checkEl) checkEl.textContent = wasTalked ? '' : '✓';

          // Update the heading badge without full re-render
          const newTalked = !wasTalked;
          if (catFilter === 'all') {
            const headings = list.querySelectorAll('.conv-cat-heading');
            headings.forEach(h => {
              // Find the heading for this category
              if (h.textContent.includes(cat.title)) {
                const newCount = cat.items.filter((_, i) =>
                  _convTalkedSet.has(convItemId(_convActiveAge, cat.id, i))
                ).length;
                const badgeHtml = newCount > 0
                  ? `<span class="conv-cat-badge">${newCount === cat.items.length ? 'All done ✓' : `${newCount}/${cat.items.length}`}</span>`
                  : '';
                h.innerHTML = `${cat.emoji} ${cat.title}${badgeHtml}`;
              }
            });
          }
        });

        list.appendChild(card);
      });
    });
  }

  // ============== IMAGEN ==============

  const IMAGEN_QUOTA_KEY   = 'drift.imagenQuota';   // { exhaustedAt: ms } | null
  const IMAGEN_QUOTA_RESET = 24 * 60 * 60 * 1000;   // 24 h in ms
  const IMAGEN_MODEL       = 'imagen-4.0-generate-001';

  function isImagenQuotaExhausted() {
    try {
      const stored = JSON.parse(localStorage.getItem(IMAGEN_QUOTA_KEY) || 'null');
      if (!stored) return false;
      return (Date.now() - stored.exhaustedAt) < IMAGEN_QUOTA_RESET;
    } catch { return false; }
  }

  function markImagenQuotaExhausted() {
    try { localStorage.setItem(IMAGEN_QUOTA_KEY, JSON.stringify({ exhaustedAt: Date.now() })); } catch {}
  }

  function clearImagenQuota() {
    try { localStorage.removeItem(IMAGEN_QUOTA_KEY); } catch {}
  }

  function buildImagenPrompt(topic, character) {
    const subject = character
      ? `a child character named ${character.split(',')[0].trim()}`
      : 'a joyful Indian child';
    return [
      'Soft watercolor children\'s book illustration,',
      `${subject} in a warm scene about "${topic}",`,
      'gentle pastel colors, Indian cultural warmth, devotional atmosphere,',
      'simple background, no text, appropriate for ages 0-5,',
      'whimsical and heartwarming style.',
    ].join(' ');
  }

  // Shrink a data-URL to a JPEG at maxPx × maxPx and the given quality (0–1).
  // Drops a typical Imagen PNG from ~1.5 MB to ~50–80 KB — safe for localStorage.
  // Preserves the natural aspect ratio of the source image.
  function compressImageDataUrl(dataUrl, maxWidth = 854, quality = 0.82) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          const scale  = Math.min(1, maxWidth / img.naturalWidth);
          canvas.width  = Math.round(img.naturalWidth  * scale);
          canvas.height = Math.round(img.naturalHeight * scale);
          canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL('image/jpeg', quality));
        } catch {
          resolve(dataUrl); // canvas blocked (e.g. CORS) — fall back to original
        }
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    });
  }

  async function generateImagenImage(topic, character, storyId) {
    const key = (window.DRIFT_CONFIG || {}).geminiKey || '';
    if (!key || isImagenQuotaExhausted()) return null;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${IMAGEN_MODEL}:predict?key=${key}`;
    const body = {
      instances: [{ prompt: buildImagenPrompt(topic, character) }],
      parameters: { sampleCount: 1, aspectRatio: '16:9' },
    };

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (res.status === 429) {
        markImagenQuotaExhausted();
        toast('Image quota reached for today — stories will still generate without illustrations.');
        return null;
      }

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        const code = (errJson?.error?.status || '').toUpperCase();
        const message = errJson?.error?.message || `HTTP ${res.status}`;
        if (code === 'RESOURCE_EXHAUSTED' || code === 'QUOTA_EXCEEDED') {
          markImagenQuotaExhausted();
          toast('Image quota reached for today — stories will still generate without illustrations.');
        } else {
          console.error('[Imagen] API error:', code, message);
        }
        return null;
      }

      const json = await res.json();
      const b64 = json?.predictions?.[0]?.bytesBase64Encoded;
      const mime = json?.predictions?.[0]?.mimeType || 'image/png';
      if (!b64) return null;

      const rawDataUrl = `data:${mime};base64,${b64}`;

      // Compress to a small JPEG before storing — Imagen returns ~1–2 MB PNG which
      // blows the localStorage quota and causes the save to fail silently.
      const dataUrl = await compressImageDataUrl(rawDataUrl, 480, 0.82);

      // Patch image onto saved story so re-reading shows it
      if (storyId !== undefined) {
        try {
          const saved = loadAISavedStories();
          const idx = saved.findIndex(s => s.id === storyId);
          if (idx !== -1) {
            saved[idx].imageUrl = dataUrl;
            localStorage.setItem(AI_SAVED_KEY, JSON.stringify(saved));
          } else {
            console.warn('[Imagen] story id not found in saved list — image not persisted');
          }
        } catch (e) {
          console.error('[Imagen] localStorage save failed (quota?):', e);
        }
      }

      return dataUrl;
    } catch (e) {
      console.error('[Imagen] Unexpected error:', e);
      return null;
    }
  }

  // ============== AI STORIES ==============

  const AI_DAILY_LIMIT_FREE = 5;
  const AI_DAILY_LIMIT_PRO  = 100;
  const AI_LS_KEY       = 'drift.aiUsage';
  const AI_SAVED_KEY    = 'drift.aiStories';
  const AI_CHARS_KEY    = 'drift.aiCharacters';

  // Pro tier accounts — these get 100 stories/day
  const PRO_EMAILS = new Set([
    'ankitpatel5@gmail.com',
    'isupiyush@gmail.com',
    'dsutaria92@gmail.com',
  ]);

  function isProUser() {
    return !!(state.user && PRO_EMAILS.has((state.user.email || '').toLowerCase()));
  }

  function aiDailyLimit() {
    return isProUser() ? AI_DAILY_LIMIT_PRO : AI_DAILY_LIMIT_FREE;
  }

  // ── Kid-friendly content filter ─────────────────────────────────
  const BLOCKED_TERMS = [
    'kill','murder','dead','death','blood','gore','stab','shoot','gun','weapon','bomb','war',
    'drug','alcohol','beer','wine','drunk','smoke','weed','cocaine',
    'sex','sexy','naked','nude','porn','adult','inappropriate',
    'hate','racist','racist','violence','rape','abuse',
    'devil','demon','satan','hell','curse','damn','crap','shit','fuck',
  ];
  function isKidFriendly(text) {
    const lower = text.toLowerCase();
    return !BLOCKED_TERMS.some((t) => lower.includes(t));
  }

  // ── Saved characters ─────────────────────────────────────────────
  function loadSavedCharacters() {
    try { return JSON.parse(localStorage.getItem(AI_CHARS_KEY) || '[]'); } catch { return []; }
  }

  function persistSavedCharacters(list) {
    try { localStorage.setItem(AI_CHARS_KEY, JSON.stringify(list)); } catch {}
  }

  function saveCharacterIfNew(char) {
    if (!char) return;
    const list = loadSavedCharacters();
    if (!list.includes(char)) {
      list.unshift(char);
      if (list.length > 10) list.splice(10);
      persistSavedCharacters(list);
    }
  }

  function renderSavedCharacters() {
    const container = $('ai-saved-chars');
    if (!container) return;
    const list = loadSavedCharacters();
    container.innerHTML = '';
    list.forEach((char) => {
      const chip = document.createElement('div');
      chip.className = 'ai-char-chip';
      chip.innerHTML = `
        <span class="ai-char-chip-name">${char}</span>
        <button class="ai-char-chip-remove" aria-label="Remove" data-char="${char.replace(/"/g, '&quot;')}">×</button>
      `;
      // Tap chip → populate input
      chip.querySelector('.ai-char-chip-name').addEventListener('click', () => {
        $('ai-character-input').value = char;
      });
      // × → remove
      chip.querySelector('.ai-char-chip-remove').addEventListener('click', (e) => {
        e.stopPropagation();
        const updated = loadSavedCharacters().filter((c) => c !== char);
        persistSavedCharacters(updated);
        renderSavedCharacters();
      });
      container.appendChild(chip);
    });
  }

  function getAIUsageToday() {
    try {
      const stored = JSON.parse(localStorage.getItem(AI_LS_KEY) || '{}');
      const today  = new Date().toISOString().slice(0, 10);
      return stored.date === today ? (stored.count || 0) : 0;
    } catch { return 0; }
  }

  function incrementAIUsage() {
    const today = new Date().toISOString().slice(0, 10);
    const count = getAIUsageToday() + 1;
    try { localStorage.setItem(AI_LS_KEY, JSON.stringify({ date: today, count })); } catch {}
  }

  function aiStoriesRef() {
    return window.fbDb.collection(`users/${state.user.uid}/aiStories`);
  }

  function loadAISavedStories() {
    try { return JSON.parse(localStorage.getItem(AI_SAVED_KEY) || '[]'); } catch { return []; }
  }

  function saveAIStory(story) {
    if (!story.id) story.id = uid();
    const saved = loadAISavedStories();
    // Upsert by ID — skip if already present so SOTD cross-saves don't duplicate
    if (saved.some((s) => s.id === story.id)) return;
    saved.unshift(story);
    if (saved.length > 20) saved.splice(20);
    try { localStorage.setItem(AI_SAVED_KEY, JSON.stringify(saved)); } catch {}
    // Sync to Firestore so stories persist across devices
    if (state.user) {
      aiStoriesRef().doc(story.id).set(story)
        .catch((e) => console.warn('aiStories Firestore save failed', e));
    }
  }

  function deleteAIStory(idx) {
    const saved = loadAISavedStories();
    const story = saved[idx];
    saved.splice(idx, 1);
    try { localStorage.setItem(AI_SAVED_KEY, JSON.stringify(saved)); } catch {}
    // Remove from Firestore
    if (state.user && story && story.id) {
      aiStoriesRef().doc(story.id).delete()
        .catch((e) => console.warn('aiStories Firestore delete failed', e));
    }
  }

  async function syncAIStoriesFromFirestore() {
    if (!state.user) return;
    try {
      const snap = await aiStoriesRef().orderBy('generatedAt', 'desc').limit(20).get();
      if (!snap.empty) {
        const firestoreStories = snap.docs.map((d) => d.data());

        // imageUrls are stored only in localStorage (not Firestore — binary data).
        // Preserve them so a sync doesn't wipe already-generated cover images.
        const local = loadAISavedStories();
        const localById = {};
        local.forEach((s) => { if (s.id) localById[s.id] = s; });

        const stories = firestoreStories.map((s) => {
          const localCopy = localById[s.id];
          return localCopy?.imageUrl ? { ...s, imageUrl: localCopy.imageUrl } : s;
        });

        try { localStorage.setItem(AI_SAVED_KEY, JSON.stringify(stories)); } catch {}
        renderAISavedList();
        renderStoryCategories(); // refresh AI card count
      }
    } catch (e) {
      console.warn('aiStories Firestore sync failed — using local cache', e);
    }
  }

  function openAIStories() {
    const key = (window.DRIFT_CONFIG || {}).geminiKey || '';
    $('ai-no-key').classList.toggle('hidden', !!key);
    $('ai-generator').classList.toggle('hidden', !key);
    renderAIUsageRow();
    renderAISavedList();      // render from local cache instantly
    renderSavedCharacters();
    syncAIStoriesFromFirestore(); // then refresh from Firestore in background
    initChildToggle();
    switchView('view-ai-stories');
    $('content').scrollTo({ top: 0, behavior: 'instant' });
  }

  function renderAIUsageRow() {
    const row   = $('ai-usage-row');
    if (!row) return;
    const limit = aiDailyLimit();
    const isPro = isProUser();
    const used  = getAIUsageToday();
    const left  = Math.max(0, limit - used);

    // For pro users show a simple text counter; for free show dots
    let content;
    if (isPro) {
      content = `<span style="color:var(--accent);font-weight:600;font-size:12px;letter-spacing:.4px;">✦ Pro Tier</span><span style="color:var(--fg-3);margin-left:8px;">${left} of ${limit} stories remaining today</span>`;
    } else {
      const dots = Array.from({ length: limit }, (_, i) =>
        `<div class="ai-usage-dot${i < used ? ' used' : ''}"></div>`
      ).join('');
      content = `<div class="ai-usage-dots">${dots}</div><span>${left} of ${limit} free stories remaining today</span>`;
    }
    row.innerHTML = content;

    const btn = $('ai-generate-btn');
    if (btn) btn.disabled = left === 0;
  }

  function renderAISavedList() {
    const saved   = loadAISavedStories();
    const section = $('ai-saved-section');
    const list    = $('ai-saved-list');
    if (!section || !list) return;

    if (!saved.length) { section.classList.add('hidden'); return; }
    section.classList.remove('hidden');
    list.innerHTML = '';

    saved.forEach((story, idx) => {
      const row = document.createElement('div');
      row.className = 'story-row' + (isStoryCompleted(story.id) ? ' done' : '');
      row.innerHTML = `
        <div class="story-row-thumb">✨</div>
        <div class="story-row-info">
          <div class="story-row-title">${story.title}</div>
          <div class="story-row-badge" style="color:var(--fg-3);">${story.topic} · ${story.length || 'medium'}</div>
        </div>
        <button class="ai-story-delete-btn" aria-label="Delete story" title="Delete">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/>
          </svg>
        </button>
      `;
      row.querySelector('.ai-story-delete-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        openConfirm(
          'Delete this story?',
          `"${story.title}" will be permanently removed.`,
          () => {
            deleteAIStory(idx); // handles both localStorage and Firestore
            renderAISavedList();
            renderStoryCategories();
          },
          { confirmLabel: 'Delete', danger: true }
        );
      });
      row.addEventListener('click', () => {
        // Re-read from localStorage so any imageUrl saved after this list rendered is included
        const fresh = loadAISavedStories();
        openAIStoryReader(fresh[idx] || story, idx);
      });
      list.appendChild(row);
    });
  }

  function openAIStoryReader(story, savedIdx) {
    state.currentStory = { ...story, type: 'text', photo: null, source: 'ai' };
    state.storyLang = 'en'; // always start as English so setStoryLang() below isn't a no-op
    stopTTS();

    // Show saved image immediately if available, otherwise show shimmer placeholder
    setStoryHeroImage(story.imageUrl || null);

    const body = $('story-reader-body');
    body.innerHTML = '';

    // AI badge
    const badge = document.createElement('div');
    badge.className = 'story-ai-badge';
    badge.innerHTML = `✨ AI Generated · ${story.topic}`;
    body.appendChild(badge);

    story.paragraphs.forEach((p, i) => {
      const el = document.createElement('p');
      el.className = 'story-para';
      el.dataset.idx = i;
      el.textContent = p;
      body.appendChild(el);
    });

    renderMarkCompleteBtn(story.id);
    renderLangToggle(true);

    const ttsBar     = $('story-tts-bar');
    const voiceSheet = $('tts-voice-sheet');
    if (voiceSheet) voiceSheet.classList.add('hidden');

    // Render title based on default lang
    const defaultLangAI = getDefaultStoryLang();
    if (ttsBar) ttsBar.classList.toggle('hidden', !isTTSAvailableForLang(defaultLangAI));

    renderStoryReaderTitle();

    // Switch to the user's default language
    if (defaultLangAI !== 'en') {
      setStoryLang(defaultLangAI);
    }

    // Override back button to return to AI stories
    $('story-reader-back')._aiMode   = true;
    $('story-reader-back')._sotdMode = false;

    updateTTSUI();
    switchView('view-story-reader');
    $('content').scrollTo({ top: 0, behavior: 'instant' });

    // Generate image in background if not already saved and quota is available
    if (!story.imageUrl && !isImagenQuotaExhausted()) {
      setStoryHeroShimmer();

      generateImagenImage(story.topic, story.character, story.id).then(dataUrl => {
        if (state.currentStory && state.currentStory.generatedAt === story.generatedAt) {
          setStoryHeroImage(dataUrl || null);
        }
      });
    }
  }

  // Themes picked when "Random" is selected
  const RANDOM_TOPICS = [
    'devotion to God',
    'seva — selfless service',
    'honesty',
    'courage',
    'gratitude',
    'forgiveness',
    'helping others',
    'patience',
    'faith in Swaminarayan',
    'humility',
    'sharing',
    'kindness to animals',
    'perseverance',
    'respect for elders',
  ];

  // Keshavi's supporting cast — mixed in for purnimagpatel57@gmail.com
  const KESHAVI_DEFAULT_CHARACTER = 'Keshavi, a curious and sweet young girl';
  const KESHAVI_SUPPORTING_CAST = [
    'Baa (her loving Grandma)',
    'Mom',
    'Dad',
    'friends at mandir',
    'a friendly animal',
    'Mota Pappa (uncle)',
    'Mota Mummy (aunt)',
    'Mahant Swami Maharaj, her Guru',
  ];
  const KESHAVI_EMAIL = 'purnimagpatel57@gmail.com';

  function isKeshaviAccount() {
    return !!(state.user && (state.user.email || '').toLowerCase() === KESHAVI_EMAIL);
  }

  async function generateAIStory() {
    const key = (window.DRIFT_CONFIG || {}).geminiKey || '';
    if (!key) { toast('Add your Gemini API key to config.js'); return; }
    if (getAIUsageToday() >= aiDailyLimit()) { toast(`Daily limit reached — come back tomorrow!`); return; }

    const topicEl  = document.querySelector('.ai-chip.active');
    let topic;
    if (topicEl && topicEl.dataset.value === 'custom') {
      topic = ($('ai-custom-topic-input').value || '').trim();
      if (!topic) {
        const errEl = $('ai-topic-error');
        if (errEl) { errEl.textContent = 'Please enter a custom theme 🙏'; errEl.classList.remove('hidden'); }
        return;
      }
      if (!isKidFriendly(topic)) {
        const errEl = $('ai-topic-error');
        if (errEl) errEl.classList.remove('hidden');
        return;
      }
    } else if (topicEl && topicEl.dataset.value === 'random') {
      topic = RANDOM_TOPICS[Math.floor(Math.random() * RANDOM_TOPICS.length)];
    } else {
      topic = topicEl ? topicEl.dataset.value : 'devotion to God';
    }

    let character = ($('ai-character-input').value || '').trim();

    // Keshavi account: default character + supporting cast when field is empty
    if (!character && isKeshaviAccount()) {
      const supporting = KESHAVI_SUPPORTING_CAST[Math.floor(Math.random() * KESHAVI_SUPPORTING_CAST.length)];
      character = `${KESHAVI_DEFAULT_CHARACTER}, joined by ${supporting}`;
    }
    const lenEl    = document.querySelector('.ai-length-btn.active');
    const length   = lenEl ? lenEl.dataset.len : 'medium';

    // Loading state
    const btn = $('ai-generate-btn');
    btn.disabled = true;
    btn.innerHTML = `<div class="ai-spinner"></div> Writing your story…`;
    const prevErr = $('ai-generator').querySelector('.ai-error-msg');
    if (prevErr) prevErr.remove();

    try {
      const prompt = buildStoryPrompt(topic, character, length);
      const result = await callGemini(key, prompt);

      if (!result.title || !Array.isArray(result.paragraphs) || !result.paragraphs.length) {
        throw new Error('Unexpected response format');
      }

      const story = {
        title: result.title,
        paragraphs: result.paragraphs,
        topic,
        character: character || null,
        length,
        generatedAt: Date.now(),
      };

      incrementAIUsage();
      saveAIStory(story);
      if (character) {
        saveCharacterIfNew(character);
        renderSavedCharacters();
      }
      renderAIUsageRow();
      renderAISavedList();

      // Open the story immediately
      openAIStoryReader(story, 0);

    } catch (e) {
      console.error('AI story error:', e);
      let msg;
      if (e.message === 'no-key') {
        msg = 'Gemini API key missing in config.js';
      } else if (e.message.includes('API_KEY_INVALID') || e.message.includes('400')) {
        msg = 'Invalid Gemini API key — check config.js';
      } else if (e.message.includes('429') || e.message.includes('RESOURCE_EXHAUSTED')) {
        msg = 'Rate limit hit — try again in a moment';
      } else if (e.message.toLowerCase().includes('high demand') || e.message.toLowerCase().includes('overloaded') || e.message.includes('503')) {
        msg = 'Gemini is busy right now — please try again in a few seconds';
      } else {
        msg = `Error: ${e.message}`;
      }
      toast(msg, 5000);
      // Also show inline so it doesn't vanish
      const errEl = document.createElement('p');
      errEl.style.cssText = 'color:var(--danger);font-size:13px;margin-top:8px;text-align:center;';
      errEl.textContent = msg;
      const existing = $('ai-generator').querySelector('.ai-error-msg');
      if (existing) existing.remove();
      errEl.className = 'ai-error-msg';
      $('ai-generate-btn').after(errEl);
    } finally {
      btn.disabled = getAIUsageToday() >= aiDailyLimit();
      btn.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg> Generate Story`;
    }
  }

  function buildStoryPrompt(topic, character, length) {
    const lengthGuide = {
      short:  '3 to 4 short paragraphs, about 120 words total',
      medium: '5 to 7 paragraphs, about 300 words total',
      long:   '8 to 12 paragraphs, about 500 words total',
    }[length] || '5 to 7 paragraphs';

    const isFunMode = topic === 'fun' || topic === 'funny';
    const isFunny   = topic === 'funny';

    if (isFunMode) {
      const characterLine = character
        ? `The main character is: ${character}.`
        : 'Choose a delightful main character — a clumsy bunny, a cheeky monkey, a forgetful elephant, or a curious little kid.';

      const toneGuide = isFunny
        ? 'Make the story laugh-out-loud funny with silly mix-ups, slapstick moments, and playful wordplay.'
        : 'Make the story joyful and adventurous — full of wonder, surprises, and playful energy.';

      return `You are a playful children's storyteller for a BAPS Swaminarayan family app.

HARD RULES — non-negotiable:
1. Do NOT force family members into the story. Characters should arise naturally from the topic and setting.
2. If and only if a family member appears naturally, use these terms: "Mummy" (mother), "Pappa" (father), "Baa" (grandmother), "Dada" (grandfather). Never use Mom, Dad, Mama, Papa, Grandma, Grandpa, or any other variant.
3. NEVER use "Bapa" to refer to a parent or any family member. In the BAPS Swaminarayan community "Bapa" is a sacred title reserved exclusively for the spiritual Guru, Mahant Swami Maharaj. Using it for a parent is deeply disrespectful and incorrect.
4. Keep all content joyful and age-appropriate — no fear, no violence.

TASK: Create a delightful, ${isFunny ? 'funny' : 'fun'} story for young children (ages 2 to 8).

${characterLine}

Story guidelines:
- Write ${lengthGuide}
- ${toneGuide}
- Use simple, bouncy language a parent can read aloud with expression
- No religious angle needed — just pure, wholesome fun
- Age-appropriate humor: silly sounds, funny mistakes, unexpected twists, happy endings

Before outputting, silently check: Did family members appear naturally, or did I force them in? If they appear, did I use only "Mummy", "Pappa", "Baa", "Dada"? Did I avoid "Bapa" for any family member?

Return a JSON object with exactly this structure (no markdown, no extra text):
{
  "title": "A short, catchy title (4 to 7 words)",
  "paragraphs": ["paragraph 1 text", "paragraph 2 text", "..."]
}`;
    }

    const characterLine = character
      ? `The main character is: ${character}.`
      : 'Choose a fitting main character — a curious child, a kind animal, a wise elder, or a young friend.';

    return `You are a warm, imaginative storyteller for an Indian-American family app.

HARD RULES — non-negotiable:
1. Do NOT force family members into the story. Characters should arise naturally from the topic and setting.
2. If and only if a family member appears naturally, use these terms: "Mummy" (mother), "Pappa" (father), "Baa" (grandmother), "Dada" (grandfather). Never use Mom, Dad, Mama, Papa, Grandma, Grandpa, or any other variant.
3. NEVER use "Bapa" to refer to a parent or any family member. In this community "Bapa" is a sacred title reserved exclusively for the spiritual Guru. Using it for a parent is deeply disrespectful and incorrect.
4. Keep all content joyful, peaceful, and age-appropriate — no fear, no violence.

TASK: Create a warm, engaging story for young children (ages 2 to 8) that teaches the value of "${topic}".

${characterLine}

Story guidelines:
- Write ${lengthGuide}
- Use simple, warm language a parent can read aloud to a baby or toddler
- Draw on universal Indian values: kindness, honesty, seva, gratitude, humility
- Stories can be set anywhere — a forest, a village, a home, a festival, a garden — let the topic guide the setting
- Occasionally (not always) stories may naturally touch on devotion or prayer, but only when it fits organically — do not force a religious angle
- Culturally rooted in an Indian family context without being narrowly religious
- End with a gentle, clear moral lesson

Before outputting, silently check: Did family members appear naturally, or did I force them in? If they appear, did I use only "Mummy", "Pappa", "Baa", "Dada"? Did I avoid "Bapa" for any family member?

Return a JSON object with exactly this structure (no markdown, no extra text):
{
  "title": "A short evocative title (4 to 7 words)",
  "paragraphs": ["paragraph 1 text", "paragraph 2 text", "..."]
}`;
  }

  async function callGemini(key, prompt) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`;
    const body = JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.8,
        maxOutputTokens: 8192,
      },
    });

    const MAX_ATTEMPTS = 3;
    const RETRY_DELAYS = [3000, 7000]; // ms between retries

    let lastError;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        const delay = RETRY_DELAYS[attempt - 1];
        const btn = $('ai-generate-btn');
        if (btn) btn.innerHTML = `<div class="ai-spinner"></div> Retrying (${attempt}/${MAX_ATTEMPTS - 1})…`;
        await new Promise((r) => setTimeout(r, delay));
      }

      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        });

        const data = await res.json();

        // Retryable: server overload (503) or explicit UNAVAILABLE/high-demand
        const isOverloaded =
          res.status === 503 ||
          (data?.error?.message || '').toLowerCase().includes('high demand') ||
          (data?.error?.message || '').toLowerCase().includes('overloaded') ||
          (data?.error?.status === 'UNAVAILABLE');

        if (!res.ok) {
          if (isOverloaded && attempt < MAX_ATTEMPTS - 1) {
            lastError = new Error(data?.error?.message || `HTTP ${res.status}`);
            continue; // retry
          }
          throw new Error(data?.error?.message || `HTTP ${res.status}`);
        }

        const raw = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!raw) throw new Error('Empty response from Gemini');

        // Strip any accidental markdown code fences
        const cleaned = raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
        return JSON.parse(cleaned);

      } catch (e) {
        // Network error — retry
        if (attempt < MAX_ATTEMPTS - 1) { lastError = e; continue; }
        throw e;
      }
    }

    throw lastError;
  }

  // ============== STORY PROGRESS & LANGUAGE ==============

  const COMPLETED_LS_KEY   = 'drift.completedStories';
  const TRANS_LS_KEY_PREFIX = 'drift.trans.v2.';

  // ── Default story language ─────────────────────────────────────
  function getDefaultStoryLang() {
    return localStorage.getItem(LS.storyLangDefault) || 'en';
  }
  function setDefaultStoryLang(lang) {
    localStorage.setItem(LS.storyLangDefault, lang);
  }

  // ── Child profile ──────────────────────────────────────────────
  function getChildProfile() {
    return {
      name:   localStorage.getItem('drift.childName')   || '',
      gender: localStorage.getItem('drift.childGender') || '',
      dob:    localStorage.getItem('drift.childDob')    || '',
    };
  }
  function saveChildProfile({ name, gender, dob }) {
    localStorage.setItem('drift.childName',   name);
    localStorage.setItem('drift.childGender', gender);
    localStorage.setItem('drift.childDob',    dob);
    // Sync to Firestore so the profile persists across domains and devices.
    // If auth hasn't resolved yet, syncChildProfileFromFirestore() will upload
    // the localStorage data once auth arrives.
    if (state.user) {
      window.fbDb.doc(`users/${state.user.uid}/settings/childProfile`)
        .set({ name, gender, dob })
        .catch((e) => console.warn('childProfile Firestore save failed:', e));
    }
  }

  async function syncChildProfileFromFirestore() {
    if (!state.user) return;
    try {
      const doc = await window.fbDb
        .doc(`users/${state.user.uid}/settings/childProfile`)
        .get();

      if (!doc.exists) {
        // Firestore has no record for this user.
        // Only push localStorage data if it was written by THIS user (same UID).
        // Never upload another user's locally-cached profile to a new account.
        const local = getChildProfile();
        const localUid = localStorage.getItem('drift.lastUserId');
        if (local.name && localUid === state.user.uid) {
          window.fbDb.doc(`users/${state.user.uid}/settings/childProfile`)
            .set(local)
            .catch((e) => console.warn('childProfile Firestore upload failed:', e));
        }
        return;
      }

      const { name = '', gender = '', dob = '' } = doc.data();
      // Only overwrite localStorage if Firestore has a name set
      // (avoids wiping a locally-set profile with an empty cloud record)
      if (!name) return;
      const hadProfile = !!localStorage.getItem('drift.childName');
      localStorage.setItem('drift.childName',   name);
      localStorage.setItem('drift.childGender', gender);
      localStorage.setItem('drift.childDob',    dob);
      // Refresh any UI that reads the profile
      refreshChildChip();
      // If localStorage was empty (e.g. new domain/device), the home feed rendered
      // with no profile and showed the setup tile. Re-run SOTD now that we have data.
      if (!hadProfile) loadStoryOfDay();
      // Also update settings form fields if the modal is currently open
      if (!hadProfile && $('settings-modal') && !$('settings-modal').classList.contains('hidden')) {
        $('child-name-input').value = name;
        $('child-dob-input').value  = dob;
        document.querySelectorAll('.child-gender-btn').forEach((b) =>
          b.classList.toggle('active', b.dataset.gender === gender)
        );
      }
    } catch (e) {
      console.warn('childProfile Firestore sync failed:', e);
    }
  }
  function calcAgeFromDob(dob) {
    if (!dob) return null;
    const birth = new Date(dob);
    const today = new Date();
    let age = today.getFullYear() - birth.getFullYear();
    const m = today.getMonth() - birth.getMonth();
    if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--;
    return age >= 0 ? age : null;
  }
  function buildChildCharacterString(profile) {
    const { name, gender } = profile;
    if (!name) return '';
    const genderWord = gender === 'girl' ? 'girl' : gender === 'boy' ? 'boy' : 'child';
    return `a ${genderWord} named ${name}`;
  }

  // ── Child chip in story generator ─────────────────────────────
  // Replaces the old checkbox-toggle pattern.
  // Chip sits below the character input as a quick-fill suggestion.
  // Selected by default when a profile exists; typing auto-deselects it.
  let _childChipActive = false;

  function refreshChildChip() {
    const profile = getChildProfile();
    const charStr = buildChildCharacterString(profile);
    const chip    = $('ai-child-chip');
    const input   = $('ai-character-input');
    if (!chip) return;

    if (!charStr) {
      chip.classList.add('hidden');
      _childChipActive = false;
      return;
    }

    chip.classList.remove('hidden');
    chip.querySelector('.ai-chip-label').textContent = profile.name;

    if (_childChipActive) {
      chip.classList.add('active');
      input.value = charStr;
    } else {
      chip.classList.remove('active');
    }
  }

  function initChildToggle() {
    const profile = getChildProfile();
    const charStr = buildChildCharacterString(profile);
    // Default to selected if a profile exists
    _childChipActive = !!charStr;
    refreshChildChip();

    const chip  = $('ai-child-chip');
    const input = $('ai-character-input');
    if (!chip || !input) return;

    // Guard: only attach listeners once (openAIStories calls this on every visit)
    if (chip._toggleInit) return;
    chip._toggleInit = true;

    // Chip tapped — toggle selection
    chip.addEventListener('click', () => {
      _childChipActive = !_childChipActive;
      if (!_childChipActive) input.value = '';
      refreshChildChip();
      if (_childChipActive) input.blur();
    });

    // User types → deselect chip (keep their text intact)
    input.addEventListener('input', () => {
      if (_childChipActive) {
        _childChipActive = false;
        const val = input.value;
        refreshChildChip();
        input.value = val;
      }
    });
  }

  // ── Completion tracking ────────────────────────────────────────
  function loadCompletedStories() {
    try { return new Set(JSON.parse(localStorage.getItem(COMPLETED_LS_KEY) || '[]')); } catch { return new Set(); }
  }
  function persistCompletedStories(set) {
    try { localStorage.setItem(COMPLETED_LS_KEY, JSON.stringify([...set])); } catch {}
  }
  function isStoryCompleted(id) {
    return loadCompletedStories().has(String(id));
  }
  function toggleStoryCompleted(id) {
    const set = loadCompletedStories();
    const sid = String(id);
    const nowDone = !set.has(sid);
    if (nowDone) set.add(sid); else set.delete(sid);
    persistCompletedStories(set);
    syncStoryProgressToFirestore(sid, nowDone);
    return nowDone;
  }

  function storyProgressRef() {
    return window.fbDb.collection(`users/${state.user.uid}/storyProgress`);
  }
  function syncStoryProgressToFirestore(id, completed) {
    if (!state.user) return;
    const ref = storyProgressRef().doc(String(id));
    (completed ? ref.set({ completedAt: Date.now() }) : ref.delete())
      .catch((e) => console.warn('storyProgress sync failed', e));
  }
  async function syncCompletedStoriesFromFirestore() {
    if (!state.user) return;
    try {
      const snap = await storyProgressRef().get();
      if (!snap.empty) {
        persistCompletedStories(new Set(snap.docs.map((d) => d.id)));
      }
    } catch (e) { console.warn('storyProgress Firestore sync failed', e); }
  }

  // ── Translation cache ──────────────────────────────────────────
  function loadTransCache(storyId) {
    try { return JSON.parse(localStorage.getItem(TRANS_LS_KEY_PREFIX + storyId) || 'null'); } catch { return null; }
  }
  function saveTransCache(storyId, data) {
    try { localStorage.setItem(TRANS_LS_KEY_PREFIX + storyId, JSON.stringify(data)); } catch {}
  }

  async function fetchTranslation(storyId, paragraphs, title) {
    // 1. Check pre-bundled translations first — these are the source of truth and override
    //    any stale localStorage cache (e.g. after a paragraph dedup fix ships).
    const bundled = window.STORY_TRANSLATIONS && window.STORY_TRANSLATIONS[storyId];
    if (bundled && Array.isArray(bundled.gujarati) && Array.isArray(bundled.transliteration)) {
      saveTransCache(storyId, bundled); // keep localStorage in sync
      return bundled;
    }

    // 2. Check localStorage cache (for AI-generated stories not in the bundle)
    const cached = loadTransCache(storyId);
    // If cached but missing title translations (old cache), bust it so we re-fetch with title
    if (cached && (title ? cached.gujaratiTitle : true)) return cached;

    // 3. Fallback: fetch live from Gemini (for AI-generated stories which have no bundle entry)
    const key = (window.DRIFT_CONFIG || {}).geminiKey || '';
    if (!key) throw new Error('no-key');

    const numbered = paragraphs.map((p, i) => `${i + 1}. "${p}"`).join('\n');
    const titleLine = title
      ? `\nStory title: "${title}"\n`
      : '';
    const titleJson = title
      ? `  "gujaratiTitle": "story title in Gujarati script",\n  "transliterationTitle": "title in phonetic Roman",\n`
      : '';
    const prompt = `You are a warm translator for a BAPS Swaminarayan children's app (ages 2–8).

Translate the following into:
1. Simple, flowing Gujarati script suitable for reading aloud to a baby or toddler (natural, not literal)
2. Roman transliteration of that Gujarati — phonetic English letters so parents who speak but cannot read Gujarati script can read aloud naturally
${titleLine}
Return ONLY valid JSON — no markdown, no extra text:
{
${titleJson}  "gujarati": ["paragraph 1 in Gujarati script", "..."],
  "transliteration": ["paragraph 1 phonetic English", "..."]
}

English paragraphs:
${numbered}`;

    const result = await callGemini(key, prompt);
    if (!Array.isArray(result.gujarati) || !Array.isArray(result.transliteration)) {
      throw new Error('Invalid translation response');
    }
    saveTransCache(storyId, result);
    return result;
  }

  // ── Story reader title + subtitle ─────────────────────────────
  function renderStoryReaderTitle() {
    const story = state.currentStory;
    if (!story) return;
    const mainEl = $('story-reader-title');
    const subEl  = $('story-reader-title-sub');
    if (!mainEl) return;

    // Static bundle covers pre-built stories; trans cache covers AI-generated ones
    const t  = (window.STORY_TITLE_TRANSLATIONS && window.STORY_TITLE_TRANSLATIONS[story.id]) || null;
    const tc = !t ? loadTransCache(story.id) : null;

    const gujaratiTitle = t ? t.gujarati      : (tc ? tc.gujaratiTitle      : null);
    const translitTitle = t ? t.transliteration : (tc ? tc.transliterationTitle : null);

    if (state.storyLang === 'en') {
      mainEl.textContent = story.title;
      if (subEl) { subEl.textContent = gujaratiTitle || ''; subEl.classList.toggle('hidden', !gujaratiTitle); }
    } else if (state.storyLang === 'gu') {
      mainEl.textContent = gujaratiTitle || story.title;
      if (subEl) { subEl.textContent = translitTitle || ''; subEl.classList.toggle('hidden', !translitTitle); }
    } else { // transliteration
      mainEl.textContent = translitTitle || story.title;
      if (subEl) { subEl.textContent = gujaratiTitle || ''; subEl.classList.toggle('hidden', !gujaratiTitle); }
    }
  }

  // ── Language switching ─────────────────────────────────────────
  function renderLangToggle(show) {
    const bar = $('story-lang-bar');
    if (!bar) return;
    if (!show) { bar.classList.add('hidden'); return; }
    bar.classList.remove('hidden');
    bar.querySelectorAll('.story-lang-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.lang === state.storyLang);
    });
  }

  // Incremented on every setStoryLang call so stale async completions can self-abort.
  let _storyLangReqId = 0;
  let _sotdReqId = 0; // incremented on each loadStoryOfDay() call so stale concurrent calls self-cancel

  async function setStoryLang(lang) {
    if (lang === state.storyLang) return;
    const story = state.currentStory;
    if (!story) return;

    // Stamp this request; any in-flight request with an older id will discard its result.
    const myReqId = ++_storyLangReqId;

    state.storyLang = lang;
    renderLangToggle(true);
    stopTTS();

    // TTS bar visibility:
    // - AI stories (SOTD / Make your own): VIP users only, regardless of language
    // - Library stories English: always show
    // - Library stories Gujarati/Transliteration: hide immediately, show only if prerendered audio exists
    state.hasPrerenderedTTS = false;
    const ttsBar = $('story-tts-bar');
    if (lang === 'en') {
      if (ttsBar) ttsBar.classList.toggle('hidden', !isTTSAvailableForLang('en'));
    } else {
      // Hide by default — reveal async only if prerendered audio doc exists in Firestore
      if (ttsBar) ttsBar.classList.add('hidden');
      if (story.id) {
        loadPrerenderedTTS(story.id).then((doc) => {
          if (_storyLangReqId !== myReqId) return;
          if (doc && (doc.paragraphUrls || doc.enParagraphUrls)) {
            state.hasPrerenderedTTS = true;
            // Only show bar if TTS is actually available (respects AI story VIP gate)
            if (isTTSAvailableForLang(lang)) {
              if (ttsBar) ttsBar.classList.remove('hidden');
            }
          }
        }).catch(() => {});
      }
    }

    // Update title + subtitle
    renderStoryReaderTitle();

    if (lang === 'en') {
      // Clear any in-flight "Translating…" spinners left by previous requests
      const body = $('story-reader-body');
      body.querySelectorAll('.story-lang-loading').forEach((el) => el.remove());
      renderStoryParagraphs(story.paragraphs, story.id);
      return;
    }

    // Check cache first (synchronous — no race possible)
    const cached = loadTransCache(story.id);
    if (cached) {
      if (_storyLangReqId !== myReqId) return; // superseded before we even paint
      renderStoryParagraphs(lang === 'gu' ? cached.gujarati : cached.transliteration, story.id);
      return;
    }

    // Fetch translation — show loading spinner in body
    const body = $('story-reader-body');
    body.querySelectorAll('.story-para').forEach((p) => p.remove());
    // Remove any leftover spinners from previous in-flight requests
    body.querySelectorAll('.story-lang-loading').forEach((el) => el.remove());
    const completeBtnWrap = body.querySelector('.story-mark-complete-wrap');
    const loader = document.createElement('div');
    loader.className = 'story-lang-loading';
    loader.innerHTML = `<div class="ai-spinner"></div><span>Translating…</span>`;
    if (completeBtnWrap) body.insertBefore(loader, completeBtnWrap);
    else body.appendChild(loader);

    try {
      const trans = await fetchTranslation(story.id, story.paragraphs, story.title);

      // By the time we're back, the user may have switched tabs — bail out silently.
      if (_storyLangReqId !== myReqId) { loader.remove(); return; }

      loader.remove();
      renderStoryParagraphs(lang === 'gu' ? trans.gujarati : trans.transliteration, story.id);
      renderStoryReaderTitle(); // title translation is now in cache — update it
    } catch (e) {
      if (_storyLangReqId !== myReqId) { loader.remove(); return; }

      loader.remove();
      const errEl = document.createElement('p');
      errEl.style.cssText = 'color:var(--danger);font-size:13px;text-align:center;padding:24px 0;';
      errEl.textContent = e.message === 'no-key'
        ? 'Add your Gemini API key to enable translation'
        : `Translation failed — ${e.message}`;
      if (completeBtnWrap) body.insertBefore(errEl, completeBtnWrap);
      else body.appendChild(errEl);
      // Revert to English
      state.storyLang = 'en';
      renderLangToggle(true);
    }
  }

  function renderStoryParagraphs(paragraphs, storyId) {
    const body = $('story-reader-body');
    if (!body || !paragraphs) return;
    body.querySelectorAll('.story-para').forEach((p) => p.remove());
    const completeBtnWrap = body.querySelector('.story-mark-complete-wrap');
    paragraphs.forEach((p, i) => {
      const el = document.createElement('p');
      el.className = 'story-para';
      el.dataset.idx = i;
      el.textContent = p;
      if (completeBtnWrap) body.insertBefore(el, completeBtnWrap);
      else body.appendChild(el);
    });
  }

  // ── Mark as read button ────────────────────────────────────────
  function renderMarkCompleteBtn(storyId) {
    const body = $('story-reader-body');
    if (!body) return;
    const existing = body.querySelector('.story-mark-complete-wrap');
    if (existing) existing.remove();

    const wrap = document.createElement('div');
    wrap.className = 'story-mark-complete-wrap';

    // Guest mode: show a prompt to sign in instead of actually marking read
    if (isGuestMode()) {
      const btn = document.createElement('button');
      btn.className = 'story-mark-guest-btn';
      btn.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="16 8 10 14 7 11"/></svg> Sign in to track read stories`;
      btn.addEventListener('click', () => {
        toast('Create a free account to track your reading progress 📚');
      });
      wrap.appendChild(btn);
      body.appendChild(wrap);
      return;
    }

    const done = isStoryCompleted(storyId);
    const btn = document.createElement('button');
    btn.className = 'story-mark-complete-btn' + (done ? ' completed' : '');
    btn.innerHTML = done
      ? `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Read`
      : `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="16 8 10 14 7 11"/></svg> Mark as read`;
    btn.addEventListener('click', () => {
      toggleStoryCompleted(storyId);
      renderMarkCompleteBtn(storyId);
      // Refresh story list completion badges if visible
      if (state.currentCatId) renderStoryList(state.currentCatId, $('story-search-input')?.value || '');
      renderAISavedList();
    });
    wrap.appendChild(btn);
    body.appendChild(wrap);
  }

  // ============== TEXT-TO-SPEECH ==============

  // Returns true when the current story is AI-generated ("Make your own" / Story of the Day)
  function isAIStory() {
    return !!(state.currentStory && state.currentStory.source === 'ai');
  }

  // Returns true when TTS should be visible for the given story language
  function isTTSAvailableForLang(lang) {
    // AI stories: VIP only — no TTS bar for regular users
    if (isAIStory()) return state.isVIPTTS;
    // Library stories (satsang/hindu/moral): always available via prerendered audio
    if (lang === 'en') return true;
    return state.hasPrerenderedTTS;    // GU/transliteration: only if Firebase has audio
  }

  const ttsState = { active: false, paused: false, idx: 0, voice: null, loading: false };
  let _ttsVoices = [];
  const TTS_AUDIO_LANG_KEY = 'drift.ttsAudioLang';
  let _ttsAudioLang = localStorage.getItem(TTS_AUDIO_LANG_KEY) || 'en'; // 'en' | 'gu'
  let _ttsTotal        = 0;   // total paragraph count, for progress bar
  let _ttsParaDurs     = [];  // known audio durations per paragraph index
  let _ttsElapsedBefore = 0; // sum of durations of paragraphs before current one
  const TTS_SPEED_KEY   = 'drift.ttsSpeed';
  const TTS_SPEED_STEPS = [0.5, 0.75, 0.85, 1, 1.25, 1.5, 1.75, 2];
  let _ttsSpeed = parseFloat(localStorage.getItem(TTS_SPEED_KEY) || '1');
  if (!TTS_SPEED_STEPS.includes(_ttsSpeed)) _ttsSpeed = 1;
  // Google TTS removed — prerendered audio covers all library stories
  let _vipAudio   = null;                    // current VIP TTS Audio element (ElevenLabs / Sarvam)
  const _sarvamCache = new Map();            // 'model|speaker|langCode|text' -> blob URL
  const _elevenLabsCache = new Map();        // 'text' -> blob URL
  const _prerenderedCache = new Map();       // storyId -> {voice, paragraphUrls:{p0,p1,...}} | null

  // Audiobook-quality voices curated for Gujarati narration
  // model: 'bulbul:v2' voices are the original set; 'bulbul:v3' is the latest generation
  const SARVAM_VOICES = [
    // ── Female ──
    { id: 'anushka',  model: 'bulbul:v2', gender: 'F', label: 'Anushka',  desc: 'Warm & Gentle' },
    { id: 'manisha',  model: 'bulbul:v2', gender: 'F', label: 'Manisha',  desc: 'Clear & Expressive' },
    { id: 'vidya',    model: 'bulbul:v2', gender: 'F', label: 'Vidya',    desc: 'Soft & Narrative' },
    { id: 'priya',    model: 'bulbul:v3', gender: 'F', label: 'Priya',    desc: 'Warm & Expressive' },
    { id: 'kavya',    model: 'bulbul:v3', gender: 'F', label: 'Kavya',    desc: 'Gentle & Clear' },
    { id: 'simran',   model: 'bulbul:v3', gender: 'F', label: 'Simran',   desc: 'Soft & Lyrical' },
    { id: 'tanya',    model: 'bulbul:v3', gender: 'F', label: 'Tanya',    desc: 'Calm & Steady' },
    { id: 'suhani',   model: 'bulbul:v3', gender: 'F', label: 'Suhani',   desc: 'Bright & Warm' },
    { id: 'roopa',    model: 'bulbul:v3', gender: 'F', label: 'Roopa',    desc: 'Rich & Full' },
    { id: 'rupali',   model: 'bulbul:v3', gender: 'F', label: 'Rupali',   desc: 'Crisp & Natural' },
    // ── Male ──
    { id: 'abhilash', model: 'bulbul:v2', gender: 'M', label: 'Abhilash', desc: 'Deep & Composed' },
    { id: 'karun',    model: 'bulbul:v2', gender: 'M', label: 'Karun',    desc: 'Strong & Clear' },
    { id: 'ratan',    model: 'bulbul:v3', gender: 'M', label: 'Ratan',    desc: 'Rich & Authoritative' },
    { id: 'advait',   model: 'bulbul:v3', gender: 'M', label: 'Advait',   desc: 'Calm & Deep' },
    { id: 'rohan',    model: 'bulbul:v3', gender: 'M', label: 'Rohan',    desc: 'Clear & Engaging' },
    { id: 'rahul',    model: 'bulbul:v3', gender: 'M', label: 'Rahul',    desc: 'Steady & Narrative' },
    { id: 'manan',    model: 'bulbul:v3', gender: 'M', label: 'Manan',    desc: 'Smooth & Consistent' },
    { id: 'kabir',    model: 'bulbul:v3', gender: 'M', label: 'Kabir',    desc: 'Bold & Resonant' },
  ];
  const SARVAM_DEFAULT_VOICE = 'rohan';

  function getSarvamVoiceId() {
    return localStorage.getItem('drift.sarvamVoice') || SARVAM_DEFAULT_VOICE;
  }
  function getSarvamVoiceObj(id) {
    return SARVAM_VOICES.find((v) => v.id === (id || getSarvamVoiceId())) || SARVAM_VOICES[3]; // priya
  }
  function setSarvamVoice(id) {
    localStorage.setItem('drift.sarvamVoice', id);
    _sarvamCache.clear();  // invalidate cache — different voice, different audio
  }

  // Google Cloud TTS removed — all library stories use prerendered Sarvam audio

  // ── Sarvam API limit: 500 chars per request — split long text into chunks ──
  // Preprocess Gujarati text so Sarvam gu-IN TTS doesn't read English punctuation literally.
  // AI-generated translations use English "." and "," — Sarvam reads them as "dot"/"comma".
  function preprocessGujaratiForTTS(text) {
    return text
      .replace(/\.+/g, '।')       // "..." or "." → single Gujarati danda (collapse runs)
      .replace(/,/g, ' ')         // Comma → pause space
      .replace(/["""'']/g, '')    // Strip curly/straight quotes
      .replace(/\s{2,}/g, ' ')    // Collapse extra spaces
      .trim();
  }

  function splitTextForSarvam(text, maxChars = 450) {
    if (text.length <= maxChars) return [text];

    const chunks = [];
    // Split on sentence-ending punctuation (Gujarati । ॥ and Latin . ? !)
    const sentences = text.split(/(?<=[.।?!॥])\s*/);
    let current = '';

    for (const sentence of sentences) {
      const s = sentence.trim();
      if (!s) continue;
      if (current.length + (current ? 1 : 0) + s.length <= maxChars) {
        current = current ? current + ' ' + s : s;
      } else {
        if (current) chunks.push(current);
        if (s.length > maxChars) {
          // Single sentence still too long — split at word boundaries
          let remainder = s;
          while (remainder.length > maxChars) {
            const cut = remainder.lastIndexOf(' ', maxChars);
            const splitAt = cut > 0 ? cut : maxChars;
            chunks.push(remainder.substring(0, splitAt).trim());
            remainder = remainder.substring(splitAt).trim();
          }
          current = remainder;
        } else {
          current = s;
        }
      }
    }
    if (current) chunks.push(current);
    return chunks.filter((c) => c.length > 0);
  }

  // ── Pre-rendered TTS lookup (Firestore prerenderedTTS/{storyId}) ─────────
  async function loadPrerenderedTTS(storyId) {
    if (_prerenderedCache.has(storyId)) return _prerenderedCache.get(storyId);
    try {
      const doc = await window.fbDb.collection('prerenderedTTS').doc(storyId).get();
      const data = doc.exists ? doc.data() : null;
      _prerenderedCache.set(storyId, data);
      return data;
    } catch (e) {
      _prerenderedCache.set(storyId, null);
      return null;
    }
  }

  // ── Sarvam AI TTS (Gujarati / Indian languages — VIP) ─────────────────────
  async function fetchSarvamAudio(text, langCode, voiceId) {
    const voice = getSarvamVoiceObj(voiceId);
    const cacheKey = `${voice.model}|${voice.id}|${langCode}|${text}`;
    if (_sarvamCache.has(cacheKey)) return _sarvamCache.get(cacheKey);

    const key = (window.DRIFT_CONFIG || {}).sarvamKey || '';
    if (!key) throw new Error('no-sarvam-key');

    // Preprocess then split into ≤450-char chunks to respect Sarvam's 500-char API limit
    const chunks = splitTextForSarvam(preprocessGujaratiForTTS(text));

    const fetchChunk = async (chunk) => {
      const res = await fetch('https://api.sarvam.ai/text-to-speech', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'api-subscription-key': key,
        },
        body: JSON.stringify({
          inputs: [chunk],
          target_language_code: langCode,
          speaker: voice.id,
          model: voice.model,
          enable_preprocessing: true,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || data.message || `Sarvam HTTP ${res.status}`);
      const b64 = data.audios?.[0];
      if (!b64) throw new Error('No audio in Sarvam response');
      const binary = atob(b64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return bytes;
    };

    // Fetch chunks sequentially (avoids rate limits) then concatenate MP3 bytes
    const audioChunks = [];
    for (const chunk of chunks) {
      audioChunks.push(await fetchChunk(chunk));
    }

    // Concatenate all MP3 byte arrays into one Blob — MP3 frames are self-contained
    const totalLength = audioChunks.reduce((sum, c) => sum + c.length, 0);
    const combined = new Uint8Array(totalLength);
    let offset = 0;
    for (const c of audioChunks) { combined.set(c, offset); offset += c.length; }

    const url = URL.createObjectURL(new Blob([combined], { type: 'audio/mpeg' }));
    _sarvamCache.set(cacheKey, url);
    return url;
  }

  // ── ElevenLabs TTS (English — VIP) ────────────────────────────────────────
  async function fetchElevenLabsAudio(text) {
    if (_elevenLabsCache.has(text)) return _elevenLabsCache.get(text);

    const cfg = window.DRIFT_CONFIG || {};
    const key = cfg.elevenLabsKey || '';
    if (!key) throw new Error('no-elevenlabs-key');
    const voiceId = cfg.elevenLabsVoiceId || '21m00Tcm4TlvDq8ikWAM'; // Rachel

    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'xi-api-key': key,
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_turbo_v2_5',
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail?.message || `ElevenLabs HTTP ${res.status}`);
    }
    const buf = await res.arrayBuffer();
    const url = URL.createObjectURL(new Blob([buf], { type: 'audio/mpeg' }));

    _elevenLabsCache.set(text, url);
    return url;
  }

  // ── Load voices — they load async in most browsers ────────────────────────
  function loadVoices() {
    if (!('speechSynthesis' in window)) return;
    const update = () => {
      const all = window.speechSynthesis.getVoices();
      if (!all.length) return;
      // Prefer English voices; surface "enhanced"/"premium"/"natural" first
      _ttsVoices = all
        .filter((v) => v.lang.startsWith('en'))
        .sort((a, b) => {
          const score = (v) => {
            const n = v.name.toLowerCase();
            if (n.includes('premium') || n.includes('enhanced')) return 0;
            if (n.includes('natural') || n.includes('neural'))   return 1;
            if (v.localService)                                   return 2;
            return 3;
          };
          return score(a) - score(b);
        });
      // Restore saved preference
      const saved = localStorage.getItem('drift.ttsVoice');
      if (saved) {
        const match = _ttsVoices.find((v) => v.name === saved);
        if (match) ttsState.voice = match;
      }
      // Auto-pick best if nothing saved
      if (!ttsState.voice && _ttsVoices.length) ttsState.voice = _ttsVoices[0];
    };
    update();
    window.speechSynthesis.onvoiceschanged = update;
  }

  function openVoicePicker() {
    const sheet = $('tts-voice-sheet');
    const list  = $('tts-voice-list');
    if (!sheet || !list) return;

    // VIP users
    if (state.isVIPTTS) {
      const isEn = state.storyLang === 'en';

      if (isEn) {
        // English: ElevenLabs — no voice selection (single voice)
        list.innerHTML = `
          <div style="padding:20px 16px;text-align:center;color:var(--fg-2);font-size:14px;line-height:1.6;">
            <div style="font-size:22px;margin-bottom:8px;">⭐</div>
            <strong>ElevenLabs · Rachel</strong><br>
            <span style="color:var(--fg-3);font-size:13px;">Natural English voice via ElevenLabs.</span>
          </div>`;
        sheet.classList.remove('hidden');
        $('tts-voice-btn').classList.add('active');
        return;
      }

      // Gujarati / Transliteration: Sarvam AI voice picker
      const currentVoiceId = getSarvamVoiceId();
      list.innerHTML = `
        <div style="padding:12px 16px 6px;font-size:11px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:var(--fg-3);">
          Sarvam AI · Gujarati Voices
        </div>
        <div style="padding:4px 16px 10px;font-size:12px;color:var(--fg-3);">Female</div>`;

      const femaleVoices = SARVAM_VOICES.filter((v) => v.gender === 'F');
      const maleVoices   = SARVAM_VOICES.filter((v) => v.gender === 'M');

      const buildItems = (voices) => {
        voices.forEach((v) => {
          const isSelected = v.id === currentVoiceId;
          const item = document.createElement('div');
          item.className = 'tts-voice-item' + (isSelected ? ' selected' : '');
          item.innerHTML = `
            <div class="tts-voice-item-info">
              <div class="tts-voice-item-name">${v.label}</div>
              <div class="tts-voice-item-lang">${v.desc} · ${v.model === 'bulbul:v2' ? 'v2' : 'v3 HD'}</div>
            </div>
            <svg class="tts-voice-item-check" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
          `;
          item.addEventListener('click', () => {
            setSarvamVoice(v.id);
            list.querySelectorAll('.tts-voice-item').forEach((el) => el.classList.remove('selected'));
            item.classList.add('selected');
            // Restart reading from current paragraph with new voice
            if (ttsState.active) {
              const resumeIdx = ttsState.idx;
              stopTTS();
              setTimeout(() => {
                ttsState.active = true;
                ttsState.paused = false;
                speakParagraph(resumeIdx);
                updateTTSUI();
              }, 80);
            }
          });
          list.appendChild(item);
        });
      };

      buildItems(femaleVoices);
      const maleDivider = document.createElement('div');
      maleDivider.style.cssText = 'padding:8px 16px 4px;font-size:12px;color:var(--fg-3);';
      maleDivider.textContent = 'Male';
      list.appendChild(maleDivider);
      buildItems(maleVoices);

      sheet.classList.remove('hidden');
      $('tts-voice-btn').classList.add('active');
      return;
    }

    if (_ttsVoices.length === 0) {
      toast('No voices found on this device');
      return;
    }

    list.innerHTML = '';
    _ttsVoices.forEach((v) => {
      const isSelected = ttsState.voice && ttsState.voice.name === v.name;
      const isEnhanced = /premium|enhanced|natural|neural/i.test(v.name);
      const item = document.createElement('div');
      item.className = 'tts-voice-item' + (isSelected ? ' selected' : '');
      // Friendly name: strip OS prefixes like "com.apple.voice.compact.en-US."
      const displayName = v.name.replace(/^.*\.\w+-\w+\./i, '').replace(/_/g, ' ');
      item.innerHTML = `
        <div class="tts-voice-item-info">
          <div class="tts-voice-item-name">${displayName}</div>
          <div class="tts-voice-item-lang">${v.lang}${v.localService ? ' · on-device' : ' · network'}</div>
        </div>
        ${isEnhanced ? '<span class="tts-voice-badge">HD</span>' : ''}
        <svg class="tts-voice-item-check" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
      `;
      item.addEventListener('click', () => {
        ttsState.voice = v;
        localStorage.setItem('drift.ttsVoice', v.name);
        // Update selection UI
        list.querySelectorAll('.tts-voice-item').forEach((el) => el.classList.remove('selected'));
        item.classList.add('selected');
        // If already reading, restart from current paragraph with new voice
        if (ttsState.active) {
          const resumeIdx = ttsState.idx;
          window.speechSynthesis.cancel();
          setTimeout(() => speakParagraph(resumeIdx), 120);
        }
        // Preview the voice
        const preview = new SpeechSynthesisUtterance('Jay Swaminarayan');
        preview.voice = v;
        preview.rate = 0.92;
        window.speechSynthesis.cancel();
        window.speechSynthesis.speak(preview);
      });
      list.appendChild(item);
    });

    sheet.classList.remove('hidden');
    $('tts-voice-btn').classList.add('active');
  }

  function closeVoicePicker() {
    const sheet = $('tts-voice-sheet');
    if (sheet) sheet.classList.add('hidden');
    const btn = $('tts-voice-btn');
    if (btn) btn.classList.remove('active');
  }

  function startTTS() {
    if (!state.currentStory) return;
    // AI stories: VIP only
    if (isAIStory() && !state.isVIPTTS) return;
    if (!state.isVIPTTS && !('speechSynthesis' in window)) {
      toast('Text-to-speech not supported on this device'); return;
    }
    ttsState.active = true;
    ttsState.paused = false;
    ttsState.loading = false;
    ttsState.idx = 0;
    speakParagraph(0);
    updateTTSUI();
  }

  function pauseTTS() {
    if (!ttsState.active || ttsState.paused) return;
    if (_vipAudio) {
      _vipAudio.pause();
    } else {
      window.speechSynthesis.pause();
    }
    ttsState.paused = true;
    ttsState.loading = false;
    updateTTSUI();
  }

  function resumeTTS() {
    if (!ttsState.active || !ttsState.paused) return;
    ttsState.paused = false;
    if (_vipAudio) {
      _vipAudio.play().catch(() => speakParagraph(ttsState.idx));
      startTTSProgressLoop();
    } else {
      // Some browsers (Chrome Android) don't resume well — restart paragraph instead
      window.speechSynthesis.resume();
      setTimeout(() => {
        if (ttsState.paused && ttsState.active) {
          ttsState.paused = false;
          window.speechSynthesis.cancel();
          speakParagraph(ttsState.idx);
        }
      }, 200);
    }
    updateTTSUI();
  }

  function stopTTS() {
    state.hasPrerenderedTTS = false;  // reset on each new story/stop
    // Stop VIP TTS audio element (ElevenLabs / Sarvam)
    if (_vipAudio) {
      _vipAudio.pause();
      _vipAudio.onended = null;
      _vipAudio.onerror = null;
      _vipAudio.src = '';
      _vipAudio = null;
    }
    // Stop Web Speech
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    ttsState.active  = false;
    ttsState.paused  = false;
    ttsState.loading = false;
    _ttsElapsedBefore = 0;
    _ttsParaDurs = [];
    stopTTSProgressLoop();
    ttsState.idx     = 0;
    document.querySelectorAll('.story-para.tts-active').forEach((el) => el.classList.remove('tts-active'));
    updateTTSUI();
  }

  // ── Progress bar helpers (module-scope so speakParagraph can call them) ──
  function fmtTime(secs) {
    if (!isFinite(secs) || secs < 0) return '';
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  function setTTSProgress(paraIdx, currentTime, audio) {
    const total = _ttsTotal;
    const bar   = $('tts-progress-bar');
    const thumb = $('tts-thumb');
    const track = $('tts-track');
    const timeEl = $('tts-time');
    if (!bar) return;

    const dur = (audio && isFinite(audio.duration) && audio.duration > 0) ? audio.duration : 0;

    let fraction;
    if (total <= 1) {
      fraction = dur > 0 ? Math.min(currentTime / dur, 1) : (ttsState.active ? 1 : 0);
    } else {
      const within = dur > 0 ? Math.min(currentTime / dur, 1) : 0;
      fraction = Math.min((paraIdx + within) / total, 1);
    }

    const pct = (fraction * 100).toFixed(2) + '%';
    bar.style.width = pct;
    if (thumb) thumb.style.left = pct;
    if (track) track.setAttribute('aria-valuenow', Math.round(fraction * 100));

    if (timeEl) {
      if (dur > 0) {
        const elapsed = _ttsElapsedBefore + currentTime / _ttsSpeed;
        const knownDurs = _ttsParaDurs.filter(d => d > 0);
        const avgDur = knownDurs.length > 0
          ? knownDurs.reduce((a, b) => a + b, 0) / knownDurs.length
          : dur / _ttsSpeed;
        const totalEst = total > 0 ? avgDur * total : avgDur;
        timeEl.textContent = fmtTime(elapsed) + ' / ' + fmtTime(Math.max(elapsed, totalEst));
      } else if (!ttsState.active) {
        timeEl.textContent = '';
      }
    }
  }

  let _ttsRafId = null;
  function startTTSProgressLoop() {
    if (_ttsRafId) return;
    function tick() {
      if (!ttsState.active) { _ttsRafId = null; return; }
      const audio = _vipAudio;
      if (audio && !audio.paused && !audio.ended && isFinite(audio.duration)) {
        setTTSProgress(ttsState.idx, audio.currentTime, audio);
      }
      _ttsRafId = requestAnimationFrame(tick);
    }
    _ttsRafId = requestAnimationFrame(tick);
  }
  function stopTTSProgressLoop() {
    if (_ttsRafId) { cancelAnimationFrame(_ttsRafId); _ttsRafId = null; }
  }

  async function speakParagraph(idx) {
    // Read text from DOM so we speak whatever language is currently displayed
    const paraEls = document.querySelectorAll('.story-para');
    if (!paraEls.length || idx >= paraEls.length) {
      stopTTS();
      return;
    }
    ttsState.idx = idx;

    // Highlight active paragraph
    paraEls.forEach((el) => {
      el.classList.toggle('tts-active', parseInt(el.dataset.idx, 10) === idx);
    });

    // Intentionally not auto-scrolling — user controls the scroll position.
    // The active paragraph is still highlighted via the tts-active class above.

    // Progress bar — paragraph-level snapshot; rAF loop refines in real-time
    _ttsTotal = paraEls.length;
    if (idx === 0) { _ttsParaDurs = []; _ttsElapsedBefore = 0; }
    setTTSProgress(idx, 0, null);

    const text = paraEls[idx].textContent || '';

    // ── Gujarati audio: use prerendered Firebase audio (driven by _ttsAudioLang, not text tab) ──
    if (_ttsAudioLang === 'gu') {
      ttsState.loading = true;
      updateTTSUI();
      try {
        const prerendered = state.currentStory ? await loadPrerenderedTTS(state.currentStory.id) : null;
        const audioUrl = prerendered?.paragraphUrls?.[`p${idx}`] || null;

        if (!ttsState.active || ttsState.paused) { ttsState.loading = false; return; }

        if (!audioUrl) {
          // No prerendered audio for this paragraph — skip to next
          ttsState.loading = false;
          updateTTSUI();
          speakParagraph(idx + 1);
          return;
        }

        if (_vipAudio) { _vipAudio.pause(); _vipAudio.onended = null; _vipAudio.onerror = null; }
        _vipAudio = new Audio(audioUrl);
        _vipAudio.playbackRate = _ttsSpeed;
        _vipAudio.onloadedmetadata = () => {
          if (isFinite(_vipAudio.duration)) {
            _ttsParaDurs[idx] = _vipAudio.duration / _ttsSpeed;
          }
        };
        ttsState.loading = false;
        updateTTSUI();
        _vipAudio.onended = () => {
          _ttsElapsedBefore += isFinite(_vipAudio.duration) ? _vipAudio.duration / _ttsSpeed : 0;
          if (ttsState.active && !ttsState.paused) speakParagraph(idx + 1);
        };
        _vipAudio.onerror = () => { if (ttsState.active && !ttsState.paused) speakParagraph(idx + 1); };
        await _vipAudio.play();
        startTTSProgressLoop();
      } catch (e) {
        ttsState.loading = false;
        console.warn('[TTS] Prerendered audio playback error:', e.message);
      }
      return;
    }

    // ── English: prerendered Sarvam (sumit) if available, else ElevenLabs / Web Speech ──
    // Check for prerendered English audio first
    if (_ttsAudioLang === 'en' && state.currentStory) {
      const prerendered = await loadPrerenderedTTS(state.currentStory.id);
      const audioUrl = prerendered?.enParagraphUrls?.[`p${idx}`] || null;
      if (!ttsState.active || ttsState.paused) { ttsState.loading = false; return; }
      if (audioUrl) {
        ttsState.loading = true;
        updateTTSUI();
        if (_vipAudio) { _vipAudio.pause(); _vipAudio.onended = null; _vipAudio.onerror = null; }
        _vipAudio = new Audio(audioUrl);
        _vipAudio.playbackRate = _ttsSpeed;
        _vipAudio.onloadedmetadata = () => {
          if (isFinite(_vipAudio.duration)) _ttsParaDurs[idx] = _vipAudio.duration / _ttsSpeed;
        };
        ttsState.loading = false;
        updateTTSUI();
        _vipAudio.onended = () => {
          _ttsElapsedBefore += isFinite(_vipAudio.duration) ? _vipAudio.duration / _ttsSpeed : 0;
          if (ttsState.active && !ttsState.paused) speakParagraph(idx + 1);
        };
        _vipAudio.onerror = () => { if (ttsState.active && !ttsState.paused) speakParagraph(idx + 1); };
        await _vipAudio.play();
        startTTSProgressLoop();
        return;
      }
      // No prerendered English audio — fall through to ElevenLabs / Web Speech
    }

    if (state.isVIPTTS) {
      ttsState.loading = true;
      updateTTSUI();
      try {
        const audioUrl = await fetchElevenLabsAudio(text);
        if (!ttsState.active || ttsState.paused) { ttsState.loading = false; return; }
        if (_vipAudio) { _vipAudio.pause(); _vipAudio.onended = null; _vipAudio.onerror = null; }
        _vipAudio = new Audio(audioUrl);
        _vipAudio.playbackRate = _ttsSpeed;
        _vipAudio.onloadedmetadata = () => {
          if (isFinite(_vipAudio.duration)) _ttsParaDurs[idx] = _vipAudio.duration / _ttsSpeed;
        };
        ttsState.loading = false;
        updateTTSUI();
        _vipAudio.onended = () => {
          _ttsElapsedBefore += isFinite(_vipAudio.duration) ? _vipAudio.duration / _ttsSpeed : 0;
          if (ttsState.active && !ttsState.paused) speakParagraph(idx + 1);
        };
        _vipAudio.onerror = () => { if (ttsState.active && !ttsState.paused) speakParagraph(idx + 1); };
        await _vipAudio.play();
        startTTSProgressLoop();
        if (idx + 1 < paraEls.length) fetchElevenLabsAudio(paraEls[idx + 1].textContent || '').catch(() => {});
        return;
      } catch (e) {
        ttsState.loading = false;
        console.warn('ElevenLabs TTS failed, falling back:', e.message);
        // Fall through to Web Speech for English
      }
    }

    // ── Web Speech fallback (English, Transliteration, or missing prerendered audio) ──
    const utter = new SpeechSynthesisUtterance(text);
    utter.rate = _ttsSpeed;

    if (state.storyLang === 'gu') {
      // Try OS Gujarati voice
      const allVoices = window.speechSynthesis.getVoices();
      const guVoice = allVoices.find((v) => v.lang.startsWith('gu'));
      if (guVoice) { utter.voice = guVoice; utter.lang = 'gu-IN'; }
      else { utter.lang = 'gu-IN'; if (ttsState.voice) utter.voice = ttsState.voice; }
    } else {
      utter.lang = 'en-US';
      if (ttsState.voice) utter.voice = ttsState.voice;
    }

    utter.onend = () => {
      if (ttsState.active && !ttsState.paused) speakParagraph(idx + 1);
    };
    utter.onerror = (e) => {
      if (e.error !== 'interrupted' && e.error !== 'canceled') console.warn('TTS error', e.error);
    };
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utter);
  }

  function updateTTSUI() {
    const playBtn = $('tts-play-btn');
    const stopBtn = $('tts-stop-btn');
    const label   = $('tts-label');
    if (!playBtn) return;

    const isLoading = ttsState.active && ttsState.loading;
    const isPlaying = ttsState.active && !ttsState.paused && !ttsState.loading;
    const isPaused  = ttsState.active && ttsState.paused;
    // Loading spinner replaces the play icon while fetching first paragraph
    if (isLoading) {
      playBtn.innerHTML = `<div class="ai-spinner" style="width:18px;height:18px;border-width:2px;"></div>`;
    } else {
      playBtn.innerHTML = isPlaying
        ? `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`
        : `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><polygon points="6 4 20 12 6 20 6 4"/></svg>`;
    }
    playBtn.setAttribute('aria-label', isPlaying ? 'Pause reading' : isPaused ? 'Resume reading' : 'Read aloud');
    playBtn.classList.toggle('reading', ttsState.active);

    if (label) {
      if (isLoading) {
        label.textContent = 'Loading…';
      } else if (isPlaying) {
        label.textContent = 'Reading…';
      } else if (isPaused) {
        label.textContent = 'Paused';
      } else {
        label.textContent = 'Read aloud';
      }
    }

    if (stopBtn) stopBtn.classList.toggle('hidden', !ttsState.active);

    if (!ttsState.active) {
      setTTSProgress(0, 0, null);
      _ttsTotal = 0;
      const timeEl = $('tts-time');
      if (timeEl) timeEl.textContent = '';
    }

    updateTTSAudioLangUI();
  }

  function updateTTSAudioLangUI() {
    const pill = $('tts-audio-lang-pill');
    if (!pill) return;
    const enBtn = pill.querySelector('[data-audio-lang="en"]');
    const guBtn = pill.querySelector('[data-audio-lang="gu"]');
    if (!enBtn || !guBtn) return;
    enBtn.classList.toggle('tts-lang-active', _ttsAudioLang === 'en');
    guBtn.classList.toggle('tts-lang-active', _ttsAudioLang === 'gu');
    // Glow the pill when audio language differs from text tab
    pill.classList.toggle('tts-lang-mismatch', _ttsAudioLang !== 'en' && state.storyLang === 'en'
      || _ttsAudioLang === 'en' && state.storyLang !== 'en');
  }

  function setTTSAudioLang(lang) {
    _ttsAudioLang = lang;
    localStorage.setItem(TTS_AUDIO_LANG_KEY, lang);
    // If TTS is currently playing, restart from current paragraph with new audio lang
    if (ttsState.active && !ttsState.paused) {
      if (_vipAudio) { _vipAudio.pause(); _vipAudio.onended = null; _vipAudio.onerror = null; _vipAudio = null; }
      window.speechSynthesis && window.speechSynthesis.cancel();
      _ttsParaDurs = [];
      _ttsElapsedBefore = 0;
      speakParagraph(ttsState.idx);
    }
    updateTTSAudioLangUI();
  }

  // ============== SEARCH ==============
  function performSearch(q) {
    q = (q || '').trim().toLowerCase();
    const results = $('search-results');
    const folders = $('folders-list');
    if (!q) {
      results.classList.add('hidden');
      folders.classList.remove('hidden');
      return;
    }
    folders.classList.add('hidden');
    results.classList.remove('hidden');
    results.innerHTML = '';
    const matches = state.flatTracks.filter((t) =>
      t.name.toLowerCase().includes(q) || t.albumName.toLowerCase().includes(q)
    ).slice(0, 100);
    if (!matches.length) {
      results.innerHTML = `<div class="empty-state"><h3>No matches</h3><p>Try a different search.</p></div>`;
      return;
    }
    matches.forEach((t, idx) => results.appendChild(renderTrackRow(t, idx + 1, 'search')));
  }

  // ============== TRACK MENU ==============
  function openTrackMenu(trackId, context) {
    const t = state.trackById[trackId];
    if (!t) return;
    state.pendingTrackId = trackId;
    state.pendingContext = context;
    $('modal-track-title').textContent = t.name;
    $('modal-track-sub').textContent = t.albumName;
    document.querySelector('[data-action="remove-from-playlist"]').classList.toggle('hidden', context !== 'playlist');
    document.querySelector('[data-action="remove-from-queue"]').classList.toggle('hidden', context !== 'queue');
    const native = isNative();
    const downloaded = isDownloaded(trackId);
    document.querySelector('[data-action="download"]').classList.toggle('hidden', !native || downloaded);
    document.querySelector('[data-action="remove-download"]').classList.toggle('hidden', !native || !downloaded);
    showModal('track-menu');
  }

  function handleTrackMenuAction(action) {
    const id = state.pendingTrackId;
    const ctx = state.pendingContext;
    closeModal('track-menu');
    if (!id) return;
    if (action === 'play-now') {
      playFromContext(id, ctx);
    } else if (action === 'play-next') {
      addToQueue(id, 'next');
      toast('Added to play next');
    } else if (action === 'add-to-queue') {
      addToQueue(id, 'end');
      toast('Added to queue');
    } else if (action === 'add-to-playlist') {
      openPlaylistPicker(id);
    } else if (action === 'remove-from-playlist') {
      if (state.activePlaylist) {
        removeFromPlaylist(state.activePlaylist.id, id);
        openPlaylist(state.activePlaylist.id);
        toast('Removed from playlist');
      }
    } else if (action === 'remove-from-queue') {
      removeFromQueue(id);
      toast('Removed from queue');
    } else if (action === 'download') {
      const track = state.trackById[id];
      const name  = track ? track.name : 'track';
      toast(`Downloading "${name}"…`);
      downloadFile(id, null).then(() => {
        toast(`"${name}" saved for offline`);
        renderLibrary(); // refresh download indicators
        if (state.activeAlbum?.id === '__downloads__') openDownloadsAlbum();
      }).catch(() => toast('Download failed'));
    } else if (action === 'remove-download') {
      removeDownload(id).then(() => {
        toast('Download removed');
        renderLibrary();
        if (state.activeAlbum?.id === '__downloads__') openDownloadsAlbum();
      });
    }
  }

  // ============== PLAYLIST PICKER ==============
  function openPlaylistPicker(trackId) {
    state.pendingTrackId = trackId;
    const list = $('picker-list');
    list.innerHTML = '';
    if (!state.playlists.length) {
      list.innerHTML = `<p class="queue-empty" style="padding: 8px 16px;">No playlists yet. Create one below.</p>`;
    } else {
      for (const p of state.playlists) {
        const btn = document.createElement('button');
        btn.className = 'picker-item';
        const exists = p.trackIds.includes(trackId);
        btn.innerHTML = `
          <div class="picker-item-art">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15V6"/><path d="M18.5 18a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z"/><path d="M12 12H3"/><path d="M16 6H3"/><path d="M12 18H3"/></svg>
          </div>
          <div style="flex:1; min-width:0;">
            <div class="picker-item-name">${escapeHtml(p.name)}</div>
            <div class="picker-item-meta">${p.trackIds.length} song${p.trackIds.length === 1 ? '' : 's'}${exists ? ' · Already added' : ''}</div>
          </div>
        `;
        applyArt(btn.querySelector('.picker-item-art'), p.name);
        btn.addEventListener('click', () => {
          const added = addToPlaylist(p.id, trackId);
          closeModal('picker-modal');
          toast(added ? `Added to "${p.name}"` : `Already in "${p.name}"`);
        });
        list.appendChild(btn);
      }
    }
    showModal('picker-modal');
  }

  // ============== PROMPT / CONFIRM ==============
  function openPrompt(title, placeholder, defaultValue, onSave) {
    $('prompt-title').textContent = title;
    $('prompt-input').placeholder = placeholder;
    $('prompt-input').value = defaultValue || '';
    showModal('prompt-modal');
    setTimeout(() => $('prompt-input').focus(), 80);
    const ok = $('prompt-ok');
    const cancel = $('prompt-cancel');
    const input = $('prompt-input');
    const handler = () => {
      const v = input.value.trim();
      if (!v) return;
      onSave(v);
      closeModal('prompt-modal');
      cleanup();
    };
    const cancelHandler = () => { closeModal('prompt-modal'); cleanup(); };
    const keyHandler = (e) => { if (e.key === 'Enter') handler(); else if (e.key === 'Escape') cancelHandler(); };
    function cleanup() {
      ok.removeEventListener('click', handler);
      cancel.removeEventListener('click', cancelHandler);
      input.removeEventListener('keydown', keyHandler);
    }
    ok.addEventListener('click', handler);
    cancel.addEventListener('click', cancelHandler);
    input.addEventListener('keydown', keyHandler);
  }

  function openConfirm(title, sub, onConfirm, opts = {}) {
    $('confirm-title').textContent = title;
    $('confirm-sub').textContent = sub;
    const ok = $('confirm-ok');
    ok.textContent = opts.confirmLabel || 'Delete';
    ok.classList.toggle('danger', opts.danger !== false);
    ok.classList.toggle('primary', opts.danger === false);
    showModal('confirm-modal');
    const cancel = $('confirm-cancel');
    const handler = () => { onConfirm(); closeModal('confirm-modal'); cleanup(); };
    const cancelHandler = () => { closeModal('confirm-modal'); cleanup(); };
    function cleanup() {
      ok.removeEventListener('click', handler);
      cancel.removeEventListener('click', cancelHandler);
    }
    ok.addEventListener('click', handler);
    cancel.addEventListener('click', cancelHandler);
  }

  // ============== MODAL / SHEET HELPERS ==============
  function showModal(id) { $(id).classList.remove('hidden'); }
  function closeModal(id) { $(id).classList.add('hidden'); }

  function openPlayerSheet() {
    if (!state.currentTrackId) return;
    $('player-sheet').classList.remove('hidden');
  }
  function closePlayerSheet() {
    $('player-sheet').classList.add('hidden');
  }

  // ============== LOADING / TOAST ==============
  function showLoading(text) {
    $('loading-text').textContent = text || 'Loading…';
    $('loading-overlay').classList.remove('hidden');
  }
  function hideLoading() {
    $('loading-overlay').classList.add('hidden');
  }
  let toastTimer = null;
  function toast(msg, duration) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), duration || 2200);
  }

  // ============== UTIL ==============
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ============== ADMIN ==============
  const ADMIN_EMAIL = 'ankitpatel5@gmail.com';

  function isAdmin() {
    return !!(state.user && state.user.email === ADMIN_EMAIL);
  }

  function updateAdminUI() {
    const btn = $('admin-btn');
    if (btn) btn.classList.toggle('hidden', !isAdmin());
  }

  function syncUserProfile(user) {
    if (!user) return;
    const ref = window.fbDb.collection('users').doc(user.uid);
    ref.get().then((doc) => {
      const data = {
        displayName: user.displayName || '',
        email: user.email || '',
        photoURL: user.photoURL || '',
        lastSeenAt: Date.now(),
      };
      if (!doc.exists) data.createdAt = Date.now();
      return ref.set(data, { merge: true });
    }).catch((e) => console.warn('syncUserProfile failed', e));
  }

  function forceBlockedSignout() {
    try { sessionStorage.setItem('drift.blocked', '1'); } catch {}
    window.fbAuth.signOut().then(() => window.location.reload());
  }

  async function checkBlockedStatus(uid) {
    try {
      const doc = await window.fbDb.collection('blockedUsers').doc(uid).get();
      if (doc.exists) forceBlockedSignout();
    } catch (e) {
      console.warn('blocked check error', e);
    }
  }

  async function checkVIPTTSAccess(user) {
    if (!user?.email) return;
    try {
      const doc = await window.fbDb.collection('vipTTSUsers').doc(user.email).get();
      state.isVIPTTS = doc.exists;
      updateTTSUI();
      // If the user is already on a story when VIP status resolves, refresh TTS bar visibility
      if (state.currentStory) {
        const ttsBar = $('story-tts-bar');
        const lang = state.storyLang || 'en';
        if (ttsBar) ttsBar.classList.toggle('hidden', !isTTSAvailableForLang(lang));
      }
    } catch (e) {
      console.warn('VIP TTS check failed — defaulting to standard TTS', e);
      state.isVIPTTS = false;
    }
  }

  function setupBlockedListener(user) {
    // 1. Real-time listener — fires instantly while the tab is active
    const unsub = window.fbDb.collection('blockedUsers').doc(user.uid)
      .onSnapshot((doc) => {
        if (doc.exists) { unsub(); forceBlockedSignout(); }
      }, (e) => {
        console.warn('blocked listener error', e);
      });

    // 2. Visibility-change fallback — catches tabs that were backgrounded
    //    (mobile browsers suspend WebSocket connections when the tab is hidden)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && state.user) {
        checkBlockedStatus(user.uid);
      }
    });
  }

  function syncPlayCountToFirestore(trackId) {
    if (!state.user) return;
    const track = state.trackById[trackId];
    const trackName = track ? track.name : trackId;
    const albumName = track ? track.albumName : '';
    const inc = firebase.firestore.FieldValue.increment(1);
    const payload = { count: inc, trackName, albumName, lastPlayedAt: Date.now() };

    // Per-user play count
    window.fbDb.collection('users').doc(state.user.uid)
      .collection('playCounts').doc(trackId)
      .set(payload, { merge: true })
      .catch((e) => console.warn('syncPlayCount (user) failed', e));

    // Global song play count
    window.fbDb.collection('songs').doc(trackId)
      .set(payload, { merge: true })
      .catch((e) => console.warn('syncPlayCount (global) failed', e));
  }

  // ============== ACCOUNT DELETION ==============
  async function deleteAccount() {
    if (!state.user) return;

    openConfirm(
      'Delete your account?',
      'This permanently deletes all your playlists, stories, and saved data. This cannot be undone.',
      async () => {
        const uid = state.user.uid;
        const db  = window.fbDb;

        // Show a blocking progress toast
        const progressEl = document.createElement('div');
        progressEl.className = 'toast toast-visible';
        progressEl.textContent = 'Deleting account…';
        document.body.appendChild(progressEl);

        try {
          // Delete all Firestore subcollections in batches
          const subcols = ['playlists', 'playCounts', 'storyOfDay', 'aiStories', 'storyProgress'];
          for (const sub of subcols) {
            try {
              const snap = await db.collection(`users/${uid}/${sub}`).get();
              if (!snap.empty) {
                const batch = db.batch();
                snap.docs.forEach((d) => batch.delete(d.ref));
                await batch.commit();
              }
            } catch (e) { /* best-effort */ }
          }

          // Delete settings doc
          try { await db.doc(`users/${uid}/settings/childProfile`).delete(); } catch (e) {}

          // Delete top-level user doc
          try { await db.collection('users').doc(uid).delete(); } catch (e) {}

          // Delete Firebase Auth user (requires recent sign-in)
          await window.fbAuth.currentUser.delete();

          // Clear all local state including onboarding + UID tracker so a
          // fresh sign-in with the same credential triggers onboarding again.
          Object.values(LS).forEach((k) => localStorage.removeItem(k));
          clearPerUserLocalStorage();
          localStorage.removeItem('drift.lastUserId');

          // Return to sign-in
          progressEl.remove();
          window.location.reload();

        } catch (e) {
          progressEl.remove();
          if (e.code === 'auth/requires-recent-login') {
            // Firestore data already deleted — just sign out silently.
            // The Firebase Auth record will be cleaned up on next sign-in attempt.
            Object.values(LS).forEach((k) => localStorage.removeItem(k));
            clearPerUserLocalStorage();
            localStorage.removeItem('drift.lastUserId');
            await window.fbAuth.signOut();
            toast('Account deleted. You have been signed out.');
            setTimeout(() => window.location.reload(), 1800);
          } else {
            toast('Could not delete account. Please try again.');
            console.error('deleteAccount failed:', e);
          }
        }
      },
      { confirmLabel: 'Delete Account', danger: true }
    );
  }

  let _adminStatsLoaded = false;

  function openAdminDashboard() {
    const panel = $('admin-panel');
    if (!panel || !isAdmin()) return;
    panel.classList.remove('hidden');
    loadAdminStats();
    loadAdminData('users');
  }

  function closeAdminDashboard() {
    const panel = $('admin-panel');
    if (panel) panel.classList.add('hidden');
  }

  async function loadAdminStats() {
    try {
      const [usersSnap, songsSnap] = await Promise.all([
        window.fbDb.collection('users').get(),
        window.fbDb.collection('songs').get(),
      ]);
      $('stat-users').textContent = usersSnap.size;
      const totalPlays = songsSnap.docs.reduce((sum, d) => sum + (d.data().count || 0), 0);
      $('stat-plays').textContent = totalPlays.toLocaleString();
      $('stat-songs').textContent = songsSnap.size;
    } catch (e) {
      console.warn('loadAdminStats failed', e);
    }
  }

  let adminCurrentTab = 'users';

  async function loadAdminData(tab) {
    adminCurrentTab = tab || adminCurrentTab;
    document.querySelectorAll('.admin-tab').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.atab === adminCurrentTab);
    });
    const content = $('admin-content');
    content.innerHTML = '<div class="admin-loading">Loading…</div>';
    if (adminCurrentTab === 'users') {
      await loadAdminUsers();
    } else if (adminCurrentTab === 'viptts') {
      await loadAdminVIPTTS();
    } else if (adminCurrentTab === 'audiobooks') {
      await loadAdminAudiobooks();
    } else if (adminCurrentTab === 'lyrics') {
      await loadAdminLyrics();
    } else {
      await loadAdminSongs();
    }
  }

  async function blockUser(uid, displayName, email) {
    if (!isAdmin()) return;
    try {
      await window.fbDb.collection('blockedUsers').doc(uid).set({
        displayName: displayName || '',
        email: email || '',
        blockedAt: Date.now(),
        blockedBy: state.user.email,
      });
      toast(`Blocked ${displayName || email || uid}`);
      loadAdminData('users');
    } catch (e) {
      console.error('blockUser failed', e);
      toast('Failed to block user');
    }
  }

  async function unblockUser(uid, displayName) {
    if (!isAdmin()) return;
    try {
      await window.fbDb.collection('blockedUsers').doc(uid).delete();
      toast(`Unblocked ${displayName || uid}`);
      loadAdminData('users');
    } catch (e) {
      console.error('unblockUser failed', e);
      toast('Failed to unblock user');
    }
  }

  async function loadAdminUsers() {
    try {
      const [usersSnap, blockedSnap] = await Promise.all([
        window.fbDb.collection('users').orderBy('lastSeenAt', 'desc').get(),
        window.fbDb.collection('blockedUsers').get(),
      ]);
      const blockedSet = new Set(blockedSnap.docs.map((d) => d.id));
      const users = usersSnap.docs.map((d) => ({
        uid: d.id, ...d.data(), blocked: blockedSet.has(d.id),
      }));
      renderAdminUsers(users);
    } catch (e) {
      console.error('loadAdminUsers failed', e);
      $('admin-content').innerHTML =
        '<div class="admin-loading">Failed to load users. Check Firestore rules.</div>';
    }
  }

  async function loadAdminSongs() {
    try {
      const snap = await window.fbDb.collection('songs')
        .orderBy('count', 'desc').limit(100).get();
      const songs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderAdminSongs(songs);
    } catch (e) {
      console.error('loadAdminSongs failed', e);
      $('admin-content').innerHTML =
        '<div class="admin-loading">Failed to load songs. Check Firestore rules.</div>';
    }
  }

  // ── VIP TTS Admin ──────────────────────────────────────────────────────────
  async function loadAdminVIPTTS() {
    try {
      const snap = await window.fbDb.collection('vipTTSUsers').get();
      const users = snap.docs.map((d) => ({ email: d.id, ...d.data() }));
      renderAdminVIPTTS(users);
    } catch (e) {
      console.error('loadAdminVIPTTS failed', e);
      $('admin-content').innerHTML =
        '<div class="admin-loading">Failed to load VIP TTS users. Check Firestore rules.</div>';
    }
  }

  async function loadAdminAudiobooks() {
    if (!isAdmin()) return;
    const content = $('admin-content');
    try {
      const snap = await window.fbDb.collection('audiobookInfo').orderBy('title').get();
      const cached = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      renderAdminAudiobooks(cached);
    } catch (e) {
      console.error('loadAdminAudiobooks failed', e);
      content.innerHTML = '<div class="admin-loading">Failed to load audiobook info cache.</div>';
    }
  }

  function renderAdminAudiobooks(cached) {
    const content = $('admin-content');
    const rows = cached.map(b => `
      <tr style="${b.failed ? 'background:rgba(200,50,50,0.08)' : ''}">
        <td style="padding:8px 10px;font-size:13px;color:${b.failed ? '#e05a5a' : 'var(--text1)'}">${b.title}</td>
        <td style="padding:8px 10px;font-size:13px;color:var(--text2)">${b.author || (b.failed ? '<span style="color:#e05a5a">Not found</span>' : '—')}</td>
        <td style="padding:8px 10px;font-size:12px;color:var(--text3);max-width:300px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${b.description || (b.failed ? '<span style="color:#e05a5a">Not found</span>' : '—')}</td>
        <td style="padding:8px 10px;font-size:11px;color:var(--text3);white-space:nowrap">${b.fetchedAt ? new Date(b.fetchedAt).toLocaleDateString() : '—'}</td>
        <td style="padding:8px 10px;display:flex;gap:6px;align-items:center">
          ${b.failed ? `<button onclick="window._adminRetryBookInfo('${b.id}','${b.title.replace(/'/g, "\\'")}')"
            style="font-size:11px;padding:3px 8px;border-radius:6px;border:1px solid var(--accent);background:transparent;color:var(--accent);cursor:pointer">Retry</button>` : ''}
          <button onclick="window._adminDeleteBookInfo('${b.id}')"
            style="font-size:11px;padding:3px 8px;border-radius:6px;border:1px solid var(--line-1);background:transparent;color:var(--text3);cursor:pointer">Delete</button>
        </td>
      </tr>`).join('');

    content.innerHTML = `
      <div style="padding:12px 0 16px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <button id="ab-prefetch-btn"
          style="padding:9px 18px;border-radius:8px;background:var(--accent);color:#000;border:none;font-size:14px;font-weight:700;cursor:pointer">
          Prefetch All Book Info
        </button>
        <button id="ab-seed-btn"
          style="padding:9px 18px;border-radius:8px;background:var(--surface3);color:var(--text1);border:1px solid var(--line-1);font-size:14px;font-weight:600;cursor:pointer">
          Seed Missing Books
        </button>
        <span id="ab-prefetch-status" style="font-size:13px;color:var(--text3)">
          ${cached.length} book${cached.length !== 1 ? 's' : ''} cached
        </span>
      </div>
      <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse">
          <thead>
            <tr style="border-bottom:1px solid var(--line-1)">
              <th style="padding:6px 10px;text-align:left;font-size:11px;color:var(--text3);font-weight:600">TITLE</th>
              <th style="padding:6px 10px;text-align:left;font-size:11px;color:var(--text3);font-weight:600">AUTHOR</th>
              <th style="padding:6px 10px;text-align:left;font-size:11px;color:var(--text3);font-weight:600">DESCRIPTION</th>
              <th style="padding:6px 10px;text-align:left;font-size:11px;color:var(--text3);font-weight:600">CACHED</th>
              <th></th>
            </tr>
          </thead>
          <tbody>${rows || '<tr><td colspan="5" style="padding:20px;color:var(--text3);font-size:13px">No books cached yet. Click Prefetch All to populate.</td></tr>'}</tbody>
        </table>
      </div>`;

    $('ab-prefetch-btn').addEventListener('click', async () => {
      const btn = $('ab-prefetch-btn');
      const status = $('ab-prefetch-status');
      btn.disabled = true;
      btn.textContent = 'Fetching…';
      await prefetchAllBookInfo((done, total) => {
        if (status) status.textContent = `${done} / ${total} fetched…`;
        if (btn) btn.textContent = `Fetching… (${done}/${total})`;
      });
      btn.textContent = 'Done!';
      if (status) status.textContent = 'All books fetched.';
      setTimeout(() => loadAdminAudiobooks(), 1000);
    });

    const SEEDED_BOOKS = [
      { title: 'Hold On to Your Kids Why Parents Need to Matter More Than Peers', author: 'Gordon Neufeld and Gabor Maté', description: 'Hold On to Your Kids argues that peer relationships have displaced parent-child relationships as the primary attachment bond, to the detriment of children\'s development. Neufeld and Maté show how to reclaim parental influence and foster the deep connection children need to thrive.' },
      { title: 'How We Grow Up', author: 'Matt Richtel', description: 'How We Grow Up: Understanding Adolescence is a Pulitzer Prize-winning reporter\'s investigation into the teenage mental-health crisis. Drawing on extensive reporting, Richtel explains the science of adolescence and offers practical guidance for parents, educators, and teens themselves.' },
      { title: 'How to Talk So Little Kids Will Listen', author: 'Joanna Faber and Julie King', description: 'How to Talk So Little Kids Will Listen is a practical guide for communicating with children ages two through seven. Faber and King offer tools for handling tantrums, encouraging cooperation, and building a warm relationship — all without threats, bribes, or power struggles.' },
      { title: 'Lisa Damour - Untangled', author: 'Lisa Damour', description: 'Untangled maps the seven transitions that turn girls into adults, from leaving childhood behind to caring about the world at large. Clinical psychologist Lisa Damour draws on research and decades of experience to help parents understand — and stay connected to — their teenage daughters.' },
      { title: 'Raising Good Humans', author: 'Hunter Clarke-Fields', description: 'Raising Good Humans teaches parents how to break the cycle of reactive, stressed-out parenting through mindfulness. Hunter Clarke-Fields combines meditation practices with practical communication skills to help parents respond calmly, model kindness, and raise caring, confident kids.' },
      { title: 'Raising a Socially Successful Child', author: 'Dr. Stephen Nowicki', description: 'Raising a Socially Successful Child teaches parents how to help their kids master nonverbal communication — the facial expressions, body language, and tone of voice that make up the majority of human interaction. Dr. Nowicki provides exercises and strategies to help children connect, communicate, and build lasting friendships.' },
      { title: 'Solid Starts for Babies', author: 'Jenny Best, Kary Rappaport, and Dr. Sakina Bajowala', description: 'Solid Starts for Babies is the definitive guide to introducing solid foods, from the team behind the popular Solid Starts app. It covers baby-led weaning, purees, allergen introduction, and choking prevention — giving parents the confidence to raise happy, adventurous eaters.' },
      { title: 'The Power of Showing Up', author: 'Daniel J. Siegel and Tina Payne Bryson', description: 'The Power of Showing Up explains the single most important thing parents can do for their children: be present. Siegel and Bryson introduce the "Four S\'s" — helping children feel Safe, Seen, Soothed, and Secure — and show how this foundation shapes resilience and wellbeing for life.' },
      { title: "What's Going on in There How the Brain and Mind Develop in the First Five Years of Life", author: 'Lise Eliot', description: "What's Going on in There is a comprehensive, research-based tour of brain development from conception through age five. Neuroscientist Lise Eliot explains how experiences, nutrition, and environment shape a child's intelligence, personality, and emotional health in the critical early years." },
    ];

    $('ab-seed-btn').addEventListener('click', async () => {
      const btn = $('ab-seed-btn');
      const status = $('ab-prefetch-status');
      btn.disabled = true;
      btn.textContent = 'Seeding…';
      let seeded = 0;
      for (const book of SEEDED_BOOKS) {
        // Skip if already cached with real data
        const existing = cached.find(b => b.title === book.title && !b.failed);
        if (existing) continue;
        // Delete any failed entry first
        const failed = cached.find(b => b.title === book.title && b.failed);
        if (failed) {
          try { await window.fbDb.collection('audiobookInfo').doc(failed.id).delete(); } catch {}
        }
        delete _abBookInfoCache[book.title];
        try {
          await window.fbDb.collection('audiobookInfo').add({
            title: book.title, author: book.author, description: book.description,
            fetchedAt: Date.now(), failed: false,
          });
          _abBookInfoCache[book.title] = { author: book.author, description: book.description };
          seeded++;
        } catch (e) { console.warn('seed failed for', book.title, e); }
      }
      btn.textContent = 'Seed Missing Books';
      btn.disabled = false;
      if (status) status.textContent = `Seeded ${seeded} book${seeded !== 1 ? 's' : ''}.`;
      setTimeout(() => loadAdminAudiobooks(), 500);
    });

    window._adminDeleteBookInfo = async (docId) => {
      try {
        await window.fbDb.collection('audiobookInfo').doc(docId).delete();
        const doc = cached.find(b => b.id === docId);
        if (doc) delete _abBookInfoCache[doc.title];
        loadAdminAudiobooks();
      } catch (e) {
        toast('Failed to delete');
      }
    };

    window._adminRetryBookInfo = (docId, title) => {
      openPrompt(
        `Retry: ${title}`,
        'Optional: author name, subtitle, or other context…',
        '',
        async (hint) => {
          try {
            await window.fbDb.collection('audiobookInfo').doc(docId).delete();
            delete _abBookInfoCache[title];
            toast(`Retrying "${title}"…`);
            await fetchBookInfo(title, hint.trim() || null);
            loadAdminAudiobooks();
          } catch (e) {
            toast('Retry failed');
          }
        }
      );
    };
  }

  // ── Admin: Lyrics ──────────────────────────────────────
  async function loadAdminLyrics() {
    if (!isAdmin()) return;
    const content = $('admin-content');
    try {
      const tracks = Object.values(state.trackById || {});
      const snap = await window.fbDb.collection('songLyrics').get();
      const lyricsMap = {};
      snap.docs.forEach(d => { lyricsMap[d.id] = d.data(); });
      renderAdminLyrics(tracks, lyricsMap);
    } catch (e) {
      console.error('loadAdminLyrics failed', e);
      content.innerHTML = '<div class="admin-loading">Failed to load lyrics data.</div>';
    }
  }

  function renderAdminLyrics(tracks, lyricsMap) {
    const content = $('admin-content');
    const sorted = [...tracks].sort((a, b) =>
      a.name.replace(/\.[^.]+$/, '').localeCompare(b.name.replace(/\.[^.]+$/, ''))
    );
    const withCount = sorted.filter(t => normalizeLyricsKey(t.name) in lyricsMap).length;
    const withoutCount = sorted.length - withCount;

    const rows = sorted.map(t => {
      const key = normalizeLyricsKey(t.name);
      const has = key in lyricsMap;
      const displayName = t.name.replace(/\.[^.]+$/, '');
      const safeKey = key.replace(/'/g, "\\'");
      const safeName = displayName.replace(/'/g, "\\'");
      return `
        <tr style="border-bottom:1px solid var(--line-1)">
          <td style="padding:10px 10px;font-size:13px;color:${has ? 'var(--text1)' : '#e05a5a'};font-weight:${has ? '400' : '500'}">${escapeHtml(displayName)}</td>
          <td style="padding:10px;font-size:12px;color:var(--text3)">${escapeHtml(t.albumName || '—')}</td>
          <td style="padding:10px">
            ${has
              ? `<span style="font-size:11px;font-weight:600;color:#4ade80;background:rgba(74,222,128,.12);border-radius:10px;padding:3px 10px">✓ Has Lyrics</span>`
              : `<span style="font-size:11px;font-weight:600;color:#e05a5a;background:rgba(224,90,90,.1);border-radius:10px;padding:3px 10px">No Lyrics</span>`
            }
          </td>
          <td style="padding:10px;font-size:12px;color:var(--text3)">${has ? escapeHtml(lyricsMap[key].language || '—') : '—'}</td>
          <td style="padding:10px">
            <button onclick="window._adminEditLyrics('${safeKey}','${safeName}')"
              style="font-size:11px;padding:4px 12px;border-radius:6px;cursor:pointer;
                ${has
                  ? 'border:1px solid var(--line-1);background:transparent;color:var(--text2)'
                  : 'border:1px solid rgba(74,222,128,.4);background:rgba(74,222,128,.1);color:#4ade80'
                }">
              ${has ? 'Edit' : '+ Add Lyrics'}
            </button>
          </td>
        </tr>`;
    }).join('');

    content.innerHTML = `
      <div style="padding:12px 0 16px;display:flex;gap:20px;align-items:center;flex-wrap:wrap">
        <span style="font-size:13px;color:var(--text3)">${sorted.length} songs total</span>
        <span style="font-size:13px;color:#4ade80;font-weight:600">● ${withCount} with lyrics</span>
        <span style="font-size:13px;color:#e05a5a;font-weight:600">● ${withoutCount} missing</span>
      </div>
      <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse">
          <thead>
            <tr style="border-bottom:2px solid var(--line-1)">
              <th style="padding:6px 10px;text-align:left;font-size:11px;color:var(--text3);font-weight:600">SONG</th>
              <th style="padding:6px 10px;text-align:left;font-size:11px;color:var(--text3);font-weight:600">FOLDER</th>
              <th style="padding:6px 10px;text-align:left;font-size:11px;color:var(--text3);font-weight:600">STATUS</th>
              <th style="padding:6px 10px;text-align:left;font-size:11px;color:var(--text3);font-weight:600">LANGUAGE</th>
              <th></th>
            </tr>
          </thead>
          <tbody>${rows || '<tr><td colspan="5" style="padding:20px;color:var(--text3);font-size:13px">No songs in library yet.</td></tr>'}</tbody>
        </table>
      </div>`;

    window._adminEditLyrics = (key, songName) => {
      openLyricsEditor(key, songName, lyricsMap[key] || null);
    };
  }

  function openLyricsEditor(key, songName, existing) {
    const content = $('admin-content');
    content.innerHTML = `
      <div style="max-width:600px;padding-bottom:40px">
        <button id="lyrics-editor-back"
          style="display:flex;align-items:center;gap:6px;font-size:13px;color:var(--accent);padding:0;margin-bottom:24px;background:none;border:none;cursor:pointer">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
          Back to Lyrics
        </button>
        <h3 style="font-size:17px;font-weight:700;margin-bottom:4px;color:var(--text1)">${escapeHtml(songName)}</h3>
        <p style="font-size:12px;color:var(--text3);margin-bottom:24px">
          Key: <code style="background:var(--surface2);padding:2px 6px;border-radius:4px;font-size:11px">${escapeHtml(key)}</code>
        </p>

        <label style="font-size:12px;font-weight:600;color:var(--text2);display:block;margin-bottom:6px">Language</label>
        <input id="lyrics-lang-input" type="text" value="${escapeHtml(existing?.language || '')}"
          placeholder="e.g. Sanskrit, Hindi, Gujarati"
          style="width:100%;padding:9px 12px;border-radius:8px;border:1px solid var(--line-1);background:var(--surface2);color:var(--text1);font-size:13px;margin-bottom:20px;outline:none"/>

        <label style="font-size:12px;font-weight:600;color:var(--text2);display:block;margin-bottom:4px">Lyrics</label>
        <p style="font-size:11px;color:var(--text3);margin-bottom:8px">One line per lyric line · blank line = stanza break</p>
        <textarea id="lyrics-text-input" rows="22"
          style="width:100%;padding:12px;border-radius:8px;border:1px solid var(--line-1);background:var(--surface2);color:var(--text1);font-size:14px;line-height:1.75;resize:vertical;font-family:inherit;outline:none"
          placeholder="Paste or type lyrics here…">${escapeHtml(existing?.lines || '')}</textarea>

        <div style="display:flex;gap:10px;margin-top:16px;align-items:center;flex-wrap:wrap">
          <button id="lyrics-save-btn"
            style="padding:10px 24px;border-radius:8px;background:var(--accent);color:#000;border:none;font-size:14px;font-weight:700;cursor:pointer">
            Save Lyrics
          </button>
          ${existing ? `<button id="lyrics-delete-btn"
            style="padding:10px 16px;border-radius:8px;background:transparent;color:#e05a5a;border:1px solid rgba(224,90,90,.4);font-size:13px;cursor:pointer">
            Delete
          </button>` : ''}
          <span id="lyrics-save-status" style="font-size:13px;color:var(--text3)"></span>
        </div>
      </div>`;

    $('lyrics-editor-back').addEventListener('click', () => loadAdminLyrics());

    $('lyrics-save-btn').addEventListener('click', async () => {
      const btn = $('lyrics-save-btn');
      const status = $('lyrics-save-status');
      const lang = $('lyrics-lang-input').value.trim();
      const lines = $('lyrics-text-input').value;
      if (!lines.trim()) { status.textContent = 'Lyrics cannot be empty.'; return; }
      btn.disabled = true;
      btn.textContent = 'Saving…';
      try {
        await window.fbDb.collection('songLyrics').doc(key).set({
          songName, language: lang, lines, updatedAt: Date.now(),
        });
        delete _lyricsCache[key]; // clear memory cache so player picks up new data
        status.textContent = '✓ Saved!';
        btn.textContent = 'Save Lyrics';
        btn.disabled = false;
        setTimeout(() => loadAdminLyrics(), 900);
      } catch (e) {
        console.error('saveLyrics failed', e);
        status.textContent = 'Error saving. Try again.';
        btn.textContent = 'Save Lyrics';
        btn.disabled = false;
      }
    });

    if (existing) {
      $('lyrics-delete-btn').addEventListener('click', async () => {
        if (!confirm(`Delete lyrics for "${songName}"?`)) return;
        try {
          await window.fbDb.collection('songLyrics').doc(key).delete();
          delete _lyricsCache[key];
          loadAdminLyrics();
        } catch (e) {
          console.error('deleteLyrics failed', e);
          toast('Error deleting lyrics.');
        }
      });
    }
  }

  function renderAdminVIPTTS(users) {
    const content = $('admin-content');
    content.innerHTML = `
      <div style="padding:12px 0 8px;display:flex;gap:8px;align-items:center;">
        <input id="vip-tts-email-input" type="email" placeholder="user@example.com"
          style="flex:1;padding:9px 12px;border-radius:8px;border:1px solid var(--border);background:var(--bg-2);color:var(--fg);font-size:14px;"/>
        <button id="vip-tts-grant-btn"
          style="padding:9px 16px;border-radius:8px;background:var(--accent);color:#fff;border:none;font-size:14px;font-weight:600;cursor:pointer;white-space:nowrap;">
          Grant Access
        </button>
      </div>
      <div style="font-size:12px;color:var(--fg-3);margin-bottom:12px;">
        English → ElevenLabs &nbsp;·&nbsp; Gujarati / Transliteration → Sarvam AI
      </div>`;

    $('vip-tts-grant-btn').addEventListener('click', () => {
      const email = $('vip-tts-email-input')?.value?.trim();
      grantVIPTTS(email);
    });

    if (!users.length) {
      const empty = document.createElement('div');
      empty.className = 'admin-loading';
      empty.style.paddingTop = '12px';
      empty.textContent = 'No VIP TTS users yet.';
      content.appendChild(empty);
      return;
    }

    const list = document.createElement('div');
    list.style.cssText = 'display:flex;flex-direction:column;gap:6px;';
    users.forEach((u) => {
      const row = document.createElement('div');
      row.style.cssText =
        'display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:10px;background:var(--bg-2);';
      const grantedDate = u.grantedAt ? new Date(u.grantedAt).toLocaleDateString() : '';
      const revokeBtn = document.createElement('button');
      revokeBtn.textContent = 'Revoke';
      revokeBtn.style.cssText =
        'padding:5px 11px;border-radius:7px;background:rgba(255,80,80,0.12);color:#f44336;border:none;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap;';
      revokeBtn.addEventListener('click', () => revokeVIPTTS(u.email));
      row.innerHTML = `
        <div style="flex:1;min-width:0;">
          <div style="font-size:14px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(u.email)}</div>
          ${grantedDate ? `<div style="font-size:12px;color:var(--fg-3);">Granted ${grantedDate}${u.grantedBy ? ` by ${escapeHtml(u.grantedBy)}` : ''}</div>` : ''}
        </div>
        <span style="padding:3px 8px;border-radius:12px;background:rgba(100,200,100,0.15);color:#4caf50;font-size:11px;font-weight:700;letter-spacing:.4px;">VIP</span>`;
      row.appendChild(revokeBtn);
      list.appendChild(row);
    });
    content.appendChild(list);
  }

  async function grantVIPTTS(email) {
    if (!email) { toast('Enter an email address'); return; }
    if (!isAdmin()) return;
    try {
      await window.fbDb.collection('vipTTSUsers').doc(email).set({
        grantedAt: Date.now(),
        grantedBy: state.user?.email || '',
      });
      toast(`✅ VIP TTS granted to ${email}`);
      loadAdminData('viptts');
    } catch (e) {
      console.error('grantVIPTTS failed', e);
      toast('Failed to grant VIP TTS access');
    }
  }

  async function revokeVIPTTS(email) {
    if (!isAdmin()) return;
    try {
      await window.fbDb.collection('vipTTSUsers').doc(email).delete();
      toast(`VIP TTS revoked for ${email}`);
      // Live-update if the currently signed-in user was revoked
      if (state.user?.email === email) {
        state.isVIPTTS = false;
        updateTTSUI();
      }
      loadAdminData('viptts');
    } catch (e) {
      console.error('revokeVIPTTS failed', e);
      toast('Failed to revoke VIP TTS access');
    }
  }

  function renderAdminUsers(users) {
    const content = $('admin-content');
    if (!users.length) {
      content.innerHTML = '<div class="admin-loading">No users yet.</div>';
      return;
    }
    content.innerHTML = '';
    users.forEach((u) => {
      const isMe = u.uid === state.user?.uid; // don't let admin block themselves
      const row = document.createElement('div');
      row.className = 'admin-user-row' + (u.blocked ? ' blocked' : '');
      const initial = (u.displayName || u.email || '?').charAt(0).toUpperCase();
      const lastSeen = u.lastSeenAt ? timeAgo(u.lastSeenAt) : 'Unknown';
      const joined = u.createdAt ? timeAgo(u.createdAt) : '';
      const blockedBadge = u.blocked
        ? `<span class="admin-user-badge">Blocked</span>`
        : '';
      const blockBtnHtml = isMe ? '' : u.blocked
        ? `<button class="admin-block-btn unblock" title="Unblock user">
             <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>
           </button>`
        : `<button class="admin-block-btn" title="Block user">
             <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>
           </button>`;
      row.innerHTML = `
        <div class="admin-user-avatar">${
          u.photoURL
            ? `<img src="${escapeHtml(u.photoURL)}" alt="${escapeHtml(initial)}" />`
            : escapeHtml(initial)
        }</div>
        <div class="admin-user-info">
          <div class="admin-user-name">${escapeHtml(u.displayName || u.email || 'Unknown')} ${blockedBadge}</div>
          <div class="admin-user-meta">${escapeHtml(u.email || '')}${joined ? ` · Joined ${joined}` : ''} · Last seen ${lastSeen}</div>
        </div>
        <div class="admin-user-actions">
          ${blockBtnHtml}
          <button class="admin-user-expand" data-uid="${escapeHtml(u.uid)}" title="View plays">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
          </button>
        </div>
      `;
      // Block / unblock
      const blockBtn = row.querySelector('.admin-block-btn');
      if (blockBtn) {
        blockBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const name = u.displayName || u.email || 'this user';
          if (u.blocked) {
            openConfirm(
              `Unblock ${name}?`,
              'They will be able to sign in again.',
              () => unblockUser(u.uid, name),
              { confirmLabel: 'Unblock', danger: false }
            );
          } else {
            openConfirm(
              `Block ${name}?`,
              'They will be signed out immediately and unable to log back in.',
              () => blockUser(u.uid, u.displayName, u.email),
              { confirmLabel: 'Block', danger: true }
            );
          }
        });
      }
      // Expand play history
      row.querySelector('.admin-user-expand').addEventListener('click', (e) => {
        const btn = e.currentTarget;
        const existing = row.querySelector('.admin-user-songs');
        if (existing) {
          existing.remove();
          btn.classList.remove('open');
          return;
        }
        btn.classList.add('open');
        loadUserSongs(btn.dataset.uid, row);
      });
      content.appendChild(row);
    });
  }

  async function loadUserSongs(uid, parentRow) {
    const placeholder = document.createElement('div');
    placeholder.className = 'admin-user-songs';
    placeholder.innerHTML = '<div class="admin-loading" style="padding:8px 16px 4px;">Loading…</div>';
    parentRow.appendChild(placeholder);
    try {
      const snap = await window.fbDb.collection('users').doc(uid)
        .collection('playCounts').orderBy('count', 'desc').limit(20).get();
      const songs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      if (!songs.length) {
        placeholder.innerHTML =
          '<div class="admin-loading" style="padding:8px 16px 4px;">No plays recorded yet.</div>';
        return;
      }
      placeholder.innerHTML = songs.map((s, i) => `
        <div class="admin-ranked-row">
          <span class="admin-rank">${i + 1}</span>
          <div class="admin-song-info">
            <div class="admin-song-name">${escapeHtml(s.trackName || s.id)}</div>
            <div class="admin-song-meta">${escapeHtml(s.albumName || '')}</div>
          </div>
          <span class="admin-song-count">${(s.count || 0).toLocaleString()}×</span>
        </div>
      `).join('');
    } catch (e) {
      placeholder.innerHTML =
        '<div class="admin-loading" style="padding:8px 16px 4px;">Failed to load.</div>';
      console.warn('loadUserSongs failed', e);
    }
  }

  function renderAdminSongs(songs) {
    const content = $('admin-content');
    if (!songs.length) {
      content.innerHTML = '<div class="admin-loading">No songs played yet.</div>';
      return;
    }
    content.innerHTML = songs.map((s, i) => `
      <div class="admin-ranked-row">
        <span class="admin-rank">${i + 1}</span>
        <div class="admin-song-info">
          <div class="admin-song-name">${escapeHtml(s.trackName || s.id)}</div>
          <div class="admin-song-meta">${escapeHtml(s.albumName || '')}</div>
        </div>
        <span class="admin-song-count">${(s.count || 0).toLocaleString()}×</span>
      </div>
    `).join('');
  }

  function timeAgo(ts) {
    const diff = Date.now() - ts;
    const sec = Math.floor(diff / 1000);
    if (sec < 60) return 'just now';
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const day = Math.floor(hr / 24);
    if (day < 30) return `${day}d ago`;
    const mo = Math.floor(day / 30);
    if (mo < 12) return `${mo}mo ago`;
    return `${Math.floor(mo / 12)}yr ago`;
  }

  // ============== EVENTS ==============
  // Safe addEventListener helper — silently skips if the element doesn't exist
  // so a single missing DOM node never crashes the entire boot sequence
  function on(id, event, handler) {
    const el = typeof id === 'string' ? $(id) : id;
    if (el) el.addEventListener(event, handler);
    else console.warn(`setupEventListeners: #${id} not found`);
  }

  function setupEventListeners() {
    try { _setupEventListenersInner(); } catch(e) {
      console.error('setupEventListeners crashed — app may be partially wired:', e);
    }
  }

  function _setupEventListenersInner() {
    // Main tabs
    document.querySelectorAll('.tab').forEach((t) => {
      t.addEventListener('click', () => switchTab(t.dataset.tab));
    });

    // Music sub-tabs (Library / Playlists / Queue)
    document.querySelectorAll('.music-subnav-btn').forEach((b) => {
      b.addEventListener('click', () => switchMusicTab(b.dataset.subtab));
    });

    // Brand logo → home tab
    $('brand-home-btn').addEventListener('click', () => switchTab('home'));

    // Theme toggle
    applyTheme(currentTheme()); // set correct icon on boot
    $('theme-btn').addEventListener('click', toggleTheme);

    // User menu
    $('user-btn').addEventListener('click', () => {
      updateUserUI();
      showModal('user-menu');
    });
    $('signout-btn').addEventListener('click', () => {
      closeModal('user-menu');
      if (isGuestMode() || !state.user) {
        // Guests (or double-tap after guest redirect) → back to sign-in screen
        promptGuestSignIn();
        return;
      }
      openConfirm(
        'Sign out?',
        'You can sign back in at any time. Your playlists are saved to the cloud.',
        () => { window.fbAuth.signOut().then(() => window.location.reload()); },
        { confirmLabel: 'Sign out', danger: false }
      );
    });
    // "Create a free account" button in user menu (visible only for guests)
    const guestCreateBtn = $('guest-create-account-btn');
    if (guestCreateBtn) {
      guestCreateBtn.addEventListener('click', () => {
        closeModal('user-menu');
        promptGuestSignIn();
      });
    }
    $('user-menu-cancel').addEventListener('click', () => closeModal('user-menu'));
    $('user-menu').addEventListener('click', (e) => { if (!e.target.closest('.modal-sheet')) closeModal('user-menu'); });

    // Delete account button (in Settings)
    const deleteAccountBtn = $('delete-account-btn');
    if (deleteAccountBtn) {
      deleteAccountBtn.addEventListener('click', () => {
        closeModal('settings-modal');
        deleteAccount();
      });
    }

    // Admin dashboard
    const adminBtn = $('admin-btn');
    if (adminBtn) adminBtn.addEventListener('click', openAdminDashboard);
    const adminClose = $('admin-close');
    if (adminClose) adminClose.addEventListener('click', closeAdminDashboard);
    document.querySelectorAll('.admin-tab').forEach((btn) => {
      btn.addEventListener('click', () => loadAdminData(btn.dataset.atab));
    });

    // Settings modal
    $('settings-btn').addEventListener('click', () => {
      // Sync audiobooks toggle state when settings opens
      const abToggleEl = $('audiobooks-toggle');
      if (abToggleEl) abToggleEl.setAttribute('aria-checked', state.audiobooksEnabled ? 'true' : 'false');

      // Guest mode: show locked child profile section
      const guestLockEl = $('settings-guest-lock');
      const childProfileForm = document.querySelector('.child-profile-form');
      const settingsSaveBtn  = $('settings-save-btn');
      const settingsHint     = document.querySelector('.settings-section-hint');

      if (isGuestMode()) {
        if (!guestLockEl && childProfileForm) {
          const lockBanner = document.createElement('div');
          lockBanner.id        = 'settings-guest-lock';
          lockBanner.className = 'settings-guest-lock';
          lockBanner.innerHTML = `
            <div class="settings-guest-lock-icon">🔒</div>
            <div class="settings-guest-lock-text">
              <div class="settings-guest-lock-title">Child Profile</div>
              <div class="settings-guest-lock-sub">Sign in to personalise stories for your child</div>
            </div>
            <button class="settings-guest-lock-btn" id="settings-guest-cta">Sign up free</button>`;
          childProfileForm.parentNode.insertBefore(lockBanner, childProfileForm);
        }
        if (childProfileForm) childProfileForm.style.display = 'none';
        if (settingsSaveBtn) settingsSaveBtn.style.display   = 'none';
        if (settingsHint)    settingsHint.style.display      = 'none';
        // Hide delete account button for guests (no account to delete)
        const dangerZone = $('settings-danger-zone');
        if (dangerZone) dangerZone.style.display = 'none';
        showModal('settings-modal');
        // Wire CTA button
        const ctaBtn = $('settings-guest-cta');
        if (ctaBtn && !ctaBtn.dataset.wired) {
          ctaBtn.dataset.wired = '1';
          ctaBtn.addEventListener('click', () => promptGuestSignIn());
        }
        return;
      }

      // Restore hidden elements if switching from guest to account (shouldn't happen
      // in one session, but guard for safety)
      if (guestLockEl) guestLockEl.style.display = 'none';
      if (childProfileForm) childProfileForm.style.display = '';
      if (settingsSaveBtn) settingsSaveBtn.style.display   = '';
      if (settingsHint)    settingsHint.style.display      = '';
      const dangerZone = $('settings-danger-zone');
      if (dangerZone) dangerZone.style.display = '';

      // Reflect current default lang selection before opening
      const curLang = getDefaultStoryLang();
      document.querySelectorAll('.settings-lang-btn').forEach((b) => {
        b.classList.toggle('active', b.dataset.lang === curLang);
      });

      // Populate child profile fields from localStorage (instant)
      const cp = getChildProfile();
      $('child-name-input').value = cp.name;
      $('child-dob-input').value  = cp.dob;
      document.querySelectorAll('.child-gender-btn').forEach((b) =>
        b.classList.toggle('active', b.dataset.gender === cp.gender)
      );

      // Inject Downloads section (native only, once)
      if (isNative() && !$('settings-downloads-section')) {
        const dlSection = document.createElement('div');
        dlSection.id        = 'settings-downloads-section';
        dlSection.className = 'settings-section';
        dlSection.innerHTML = `
          <div class="settings-section-label">Downloads</div>
          <div id="settings-dl-list" class="settings-dl-list"></div>
          <button class="modal-item danger hidden" id="settings-dl-clear-btn">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
            Remove All Downloads
          </button>`;
        const cancelBtn = $('settings-cancel');
        cancelBtn.parentNode.insertBefore(dlSection, cancelBtn);
        $('settings-dl-clear-btn').addEventListener('click', async () => {
          const keys = await dlKeys();
          await Promise.all(keys.map(k => removeDownload(k)));
          toast('All downloads removed');
          renderDlSettingsSection();
          renderLibrary();
        });
      }
      renderDlSettingsSection();

      showModal('settings-modal');
      snapshotSettings(); // capture state so Cancel can revert

      // Also pull fresh from Firestore in case localStorage is empty (e.g. new domain/device)
      if (state.user && !cp.name) {
        window.fbDb.doc(`users/${state.user.uid}/settings/childProfile`).get()
          .then((doc) => {
            if (!doc.exists) return;
            const { name = '', gender = '', dob = '' } = doc.data();
            if (!name) return;
            $('child-name-input').value = name;
            $('child-dob-input').value  = dob;
            document.querySelectorAll('.child-gender-btn').forEach((b) =>
              b.classList.toggle('active', b.dataset.gender === gender)
            );
            localStorage.setItem('drift.childName',   name);
            localStorage.setItem('drift.childGender', gender);
            localStorage.setItem('drift.childDob',    dob);
            refreshChildChip();
          })
          .catch(() => {});
      }
    });

    // Child profile — gender buttons (UI only, no auto-save)
    document.querySelectorAll('.child-gender-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.child-gender-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        checkSettingsDirty();
      });
    });

    // Settings — snapshot for cancel revert (child profile + story language)
    let _settingsSnapshot = null;
    function snapshotSettings() {
      _settingsSnapshot = {
        name:   $('child-name-input').value,
        gender: document.querySelector('.child-gender-btn.active')?.dataset.gender || '',
        dob:    $('child-dob-input').value,
        lang:   document.querySelector('.settings-lang-btn.active')?.dataset.lang || getDefaultStoryLang(),
      };
      // Reset Save button to disabled after snapshot (fresh save or modal open)
      const saveBtn = $('settings-save-btn');
      if (saveBtn) { saveBtn.disabled = true; }
    }
    function revertSettings() {
      if (!_settingsSnapshot) return;
      $('child-name-input').value = _settingsSnapshot.name;
      $('child-dob-input').value  = _settingsSnapshot.dob;
      document.querySelectorAll('.child-gender-btn').forEach((b) =>
        b.classList.toggle('active', b.dataset.gender === _settingsSnapshot.gender)
      );
      document.querySelectorAll('.settings-lang-btn').forEach((b) =>
        b.classList.toggle('active', b.dataset.lang === _settingsSnapshot.lang)
      );
      const saveBtn = $('settings-save-btn');
      if (saveBtn) { saveBtn.disabled = true; }
    }
    function checkSettingsDirty() {
      if (!_settingsSnapshot) return;
      const name   = $('child-name-input').value;
      const dob    = $('child-dob-input').value;
      const gender = document.querySelector('.child-gender-btn.active')?.dataset.gender || '';
      const lang   = document.querySelector('.settings-lang-btn.active')?.dataset.lang || '';
      const dirty  = name   !== _settingsSnapshot.name   ||
                     dob    !== _settingsSnapshot.dob    ||
                     gender !== _settingsSnapshot.gender ||
                     lang   !== _settingsSnapshot.lang;
      const saveBtn = $('settings-save-btn');
      if (saveBtn) { saveBtn.disabled = !dirty; }
    }

    // Wire dirty-check to name and dob inputs
    $('child-name-input').addEventListener('input', checkSettingsDirty);
    $('child-dob-input').addEventListener('change', checkSettingsDirty);

    // Settings Save button — commits child profile + story language
    $('settings-save-btn').addEventListener('click', () => {
      if ($('settings-save-btn').disabled) return;
      const gender = document.querySelector('.child-gender-btn.active')?.dataset.gender || '';
      saveChildProfile({
        name:   ($('child-name-input').value || '').trim(),
        gender,
        dob:    ($('child-dob-input').value  || '').trim(),
      });
      refreshChildChip();

      // Commit story language
      const lang = document.querySelector('.settings-lang-btn.active')?.dataset.lang || 'en';
      setDefaultStoryLang(lang);
      // Sync story list lang toggle
      const listLang = (lang === 'gu') ? 'gu' : 'en';
      state.storyListLang = listLang;
      try { localStorage.setItem('drift.storyListLang', listLang); } catch {}
      document.querySelectorAll('.story-list-lang-btn').forEach((b) =>
        b.classList.toggle('active', b.dataset.lang === listLang)
      );
      if (state.currentCatId) renderStoryList(state.currentCatId, $('story-search-input')?.value || '');

      closeModal('settings-modal');
      toast('Settings saved');
    });

    // Cancel / close — revert unsaved changes and close modal
    function closeSettings() {
      revertSettings(); // discard any unsaved edits
      closeModal('settings-modal');
    }
    $('settings-cancel').addEventListener('click', closeSettings);
    $('settings-modal').addEventListener('click', (e) => { if (!e.target.closest('.modal-sheet')) closeSettings(); });

    // Advanced section toggle
    $('settings-advanced-toggle').addEventListener('click', () => {
      const body = $('settings-advanced-body');
      const btn  = $('settings-advanced-toggle');
      const open = body.classList.toggle('hidden');
      btn.setAttribute('aria-expanded', open ? 'false' : 'true');
    });

    // Story list language toggle (EN / ગુ)
    document.querySelectorAll('.story-list-lang-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.storyListLang = btn.dataset.lang;
        try { localStorage.setItem('drift.storyListLang', state.storyListLang); } catch {}
        document.querySelectorAll('.story-list-lang-btn').forEach((b) =>
          b.classList.toggle('active', b.dataset.lang === state.storyListLang)
        );
        renderStoryList(state.currentCatId, $('story-search-input')?.value || '');
      });
    });

    // Default story language picker inside settings (UI-only — committed on Save)
    document.querySelectorAll('.settings-lang-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.settings-lang-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        checkSettingsDirty();
      });
    });
    // Audiobooks toggle
    const abToggle = $('audiobooks-toggle');
    if (abToggle) {
      abToggle.setAttribute('aria-checked', state.audiobooksEnabled ? 'true' : 'false');
      abToggle.addEventListener('click', () => {
        state.audiobooksEnabled = !state.audiobooksEnabled;
        abToggle.setAttribute('aria-checked', state.audiobooksEnabled ? 'true' : 'false');
        localStorage.setItem(LS.audiobooksEnabled, state.audiobooksEnabled ? '1' : '0');
        applyAudiobooksTab();
        saveAudiobooksSettingToFirestore();
        if (state.audiobooksEnabled) {
          toast('Audiobooks tab enabled');
          loadAudiobookLibrary(); // pre-load in background
        } else {
          toast('Audiobooks tab hidden');
          if (state.currentTab === 'audiobooks') switchTab('home');
        }
      });
    }

    $('settings-refresh').addEventListener('click', async () => {
      closeModal('settings-modal');
      document.body.classList.add('refreshing');
      try {
        const fresh = await buildLibrary();
        applyLibrary(fresh);
        try { localStorage.setItem(LS.library, JSON.stringify({ albums: fresh.albums, updatedAt: fresh.updatedAt })); } catch {}
        renderLibrary();
        $('library-sub').textContent = `${state.library.albums.length} albums · ${state.flatTracks.length} songs`;
        toast('Library refreshed');
      } catch (e) {
        toast('Refresh failed');
      } finally {
        setTimeout(() => document.body.classList.remove('refreshing'), 400);
      }
    });

    // Search
    const searchInput = $('search-input');
    searchInput.addEventListener('input', (e) => {
      performSearch(e.target.value);
      $('search-clear').classList.toggle('hidden', !e.target.value);
    });
    $('search-clear').addEventListener('click', () => {
      searchInput.value = '';
      performSearch('');
      $('search-clear').classList.add('hidden');
    });

    // Album view
    $('album-back').addEventListener('click', () => switchTab('library'));
    $('album-play').addEventListener('click', () => state.activeAlbum && playAlbum(state.activeAlbum.id, false));
    $('album-shuffle').addEventListener('click', () => state.activeAlbum && playAlbum(state.activeAlbum.id, true));

    // Playlist view
    $('playlist-back').addEventListener('click', () => switchTab('playlists'));
    $('playlist-play').addEventListener('click', () => state.activePlaylist && playPlaylist(state.activePlaylist.id, false));
    $('playlist-shuffle').addEventListener('click', () => state.activePlaylist && playPlaylist(state.activePlaylist.id, true));
    $('playlist-rename').addEventListener('click', () => {
      if (!state.activePlaylist) return;
      openPrompt('Rename playlist', 'Name', state.activePlaylist.name, (v) => {
        renamePlaylist(state.activePlaylist.id, v);
        openPlaylist(state.activePlaylist.id);
      });
    });
    $('playlist-delete').addEventListener('click', () => {
      if (!state.activePlaylist) return;
      const id = state.activePlaylist.id;
      const name = state.activePlaylist.name;
      openConfirm(
        `Delete "${name}"?`,
        'The songs in your library are not affected.',
        () => {
          deletePlaylist(id);
          state.activePlaylist = null;
          switchTab('playlists');
        },
        { confirmLabel: 'Delete', danger: true }
      );
    });
    $('playlist-share').addEventListener('click', () => {
      if (state.activePlaylist) sharePlaylist(state.activePlaylist.id);
    });

    // Import shared playlist
    $('import-confirm').addEventListener('click', importSharedPlaylist);
    const closeImport = () => { state.pendingShareDoc = null; closeModal('import-modal'); };
    $('import-cancel').addEventListener('click', closeImport);
    $('import-modal').addEventListener('click', (e) => { if (!e.target.closest('.modal-sheet')) closeImport(); });

    // New playlist
    $('new-playlist-btn').addEventListener('click', () => {
      if (isGuestMode()) {
        toast('Create a free account to build playlists');
        return;
      }
      openPrompt('New playlist', 'My playlist', '', (v) => {
        const p = createPlaylist(v);
        renderPlaylists();
        openPlaylist(p.id);
      });
    });

    // Queue clear
    $('queue-clear').addEventListener('click', () => {
      if (!state.queue.length) { toast('Queue is already empty'); return; }
      clearQueue();
      toast('Queue cleared');
    });

    // ── AI Stories ──────────────────────────────────────
    $('ai-stories-back').addEventListener('click', () => {
      switchView('view-stories');
      renderStoryCategories(); // refresh AI card count
      $('content').scrollTo({ top: 0, behavior: 'instant' });
    });

    // Topic chips — single select
    $('ai-topic-chips').addEventListener('click', (e) => {
      const chip = e.target.closest('.ai-chip');
      if (!chip) return;
      document.querySelectorAll('.ai-chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      // Show custom topic input only when "custom" chip is selected
      const isCustom = chip.dataset.value === 'custom';
      const wrap = $('ai-custom-topic-wrap');
      if (wrap) wrap.classList.toggle('hidden', !isCustom);
      if (isCustom) {
        const inp = $('ai-custom-topic-input');
        if (inp) setTimeout(() => inp.focus(), 80);
      }
    });

    // Clear custom topic error as user types
    const customTopicInput = $('ai-custom-topic-input');
    if (customTopicInput) {
      customTopicInput.addEventListener('input', () => {
        const errEl = $('ai-topic-error');
        if (errEl) errEl.classList.add('hidden');
      });
    }

    // Length buttons — single select
    document.querySelectorAll('.ai-length-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.ai-length-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });

    $('ai-generate-btn').addEventListener('click', generateAIStory);

    $('ai-clear-btn').addEventListener('click', () => {
      openConfirm(
        'Clear all AI stories?',
        'Your generated stories will be permanently deleted.',
        async () => {
          localStorage.removeItem(AI_SAVED_KEY);
          renderAISavedList();
          renderStoryCategories();
          toast('Stories cleared');
          // Also wipe from Firestore
          if (state.user) {
            try {
              const snap = await aiStoriesRef().get();
              if (!snap.empty) {
                const batch = window.fbDb.batch();
                snap.docs.forEach((d) => batch.delete(d.ref));
                await batch.commit();
              }
            } catch (e) {
              console.warn('aiStories Firestore clear failed', e);
            }
          }
        },
        { confirmLabel: 'Clear all', danger: true }
      );
    });

    // ── Story Time ──────────────────────────────────────
    $('conv-ages-back').addEventListener('click', () => switchTab('stories'));

    // Audiobooks back + more details toggle
    $('ab-resync-btn').addEventListener('click', async () => {
      const btn = $('ab-resync-btn');
      if (btn) { btn.disabled = true; btn.textContent = 'Syncing…'; }
      _abLibrary = null;
      await renderAudiobookLibrary();
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7"/><polyline points="21 3 21 9 15 9"/></svg> Sync Library`;
      }
    });

    $('ab-detail-back').addEventListener('click', () => {
      // Snapshot current position into memory right now, before anything else
      if (_abAudio && _abBook && _abAudio.currentTime > 2 && _abAudio.duration) {
        const ch = _abBook.chapters[_abChapterIdx];
        if (ch) {
          const chStart = ch.startTime ?? 0;
          const chEnd   = ch.endTime   ?? _abAudio.duration;
          saveAbProgress(_abBook.id, ch.id, Math.max(0, _abAudio.currentTime - chStart), chEnd - chStart);
        }
      }
      flushAbProgressToFirestore();
      abPause();
      renderAudiobookLibrary();
      switchView('view-audiobooks');
      $('content').scrollTo({ top: 0, behavior: 'instant' });
    });
    $('ab-more-details-toggle').addEventListener('click', () => {
      const toggle = $('ab-more-details-toggle');
      const body   = $('ab-more-details-body');
      toggle.classList.toggle('open');
      body.classList.toggle('open');
    });
    $('conv-starters-back').addEventListener('click', () => {
      switchView('view-conv-ages');
      $('content').scrollTo({ top: 0, behavior: 'instant' });
    });

    $('story-list-back').addEventListener('click', () => {
      stopTTS();
      switchTab('stories');
    });
    $('story-reader-back').addEventListener('click', () => {
      stopTTS();
      closeSizePopover();
      const btn = $('story-reader-back');
      if (btn._sotdMode) {
        btn._sotdMode = false;
        switchTab('home');
      } else if (btn._aiMode) {
        btn._aiMode = false;
        switchView('view-ai-stories');
      } else {
        switchView('view-story-list');
      }
      $('content').scrollTo({ top: 0, behavior: 'instant' });
    });

    // ── Text size (Aa) ────────────────────────────────────────────
    const STORY_SIZE_KEY = 'drift.storyTextSize';
    const STORY_SIZES    = { sm: true, md: true, lg: true, xl: true };

    function applyStorySize(size) {
      if (!STORY_SIZES[size]) size = 'md';
      document.body.dataset.storySize = size;
      // highlight selected chip
      document.querySelectorAll('.story-size-opt').forEach(el => {
        el.classList.toggle('size-selected', el.dataset.size === size);
      });
      // tint Aa button when non-default
      const aaBtn = $('story-aa-btn');
      if (aaBtn) aaBtn.classList.toggle('aa-active', size !== 'md');
    }

    function closeSizePopover() {
      const pop = $('story-size-popover');
      const btn = $('story-aa-btn');
      if (!pop) return;
      pop.classList.add('hidden');
      if (btn) btn.setAttribute('aria-expanded', 'false');
    }

    // Restore persisted size on boot
    applyStorySize(localStorage.getItem(STORY_SIZE_KEY) || 'md');

    $('story-aa-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      const pop = $('story-size-popover');
      const btn = $('story-aa-btn');
      const isOpen = !pop.classList.contains('hidden');
      if (isOpen) {
        closeSizePopover();
      } else {
        pop.classList.remove('hidden');
        btn.setAttribute('aria-expanded', 'true');
      }
    });

    document.querySelectorAll('.story-size-opt').forEach(el => {
      el.addEventListener('click', () => {
        const size = el.dataset.size;
        applyStorySize(size);
        localStorage.setItem(STORY_SIZE_KEY, size);
        // auto-close after a brief moment so user sees the selection
        setTimeout(closeSizePopover, 500);
      });
    });

    // Close popover when tapping outside
    document.addEventListener('click', (e) => {
      const pop = $('story-size-popover');
      if (pop && !pop.classList.contains('hidden') &&
          !pop.contains(e.target) && e.target !== $('story-aa-btn')) {
        closeSizePopover();
      }
    });
    const storySearchInput = $('story-search-input');
    storySearchInput.addEventListener('input', () => {
      const v = storySearchInput.value;
      $('story-search-clear').classList.toggle('hidden', !v);
      renderStoryList(state.currentCatId, v);
    });
    $('story-search-clear').addEventListener('click', () => {
      storySearchInput.value = '';
      $('story-search-clear').classList.add('hidden');
      renderStoryList(state.currentCatId, '');
    });
    $('tts-play-btn').addEventListener('click', () => {
      if (!ttsState.active) startTTS();
      else if (ttsState.paused) resumeTTS();
      else pauseTTS();
    });
    $('tts-stop-btn').addEventListener('click', stopTTS);

    // ── Audio language pill ───────────────────────────────────────
    const _ttsPill = $('tts-audio-lang-pill');
    if (_ttsPill) {
      _ttsPill.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-audio-lang]');
        if (!btn) return;
        setTTSAudioLang(btn.dataset.audioLang);
      });
    }
    updateTTSAudioLangUI();

    // ── Playback speed ────────────────────────────────────────────
    function applyTTSSpeed(speed) {
      _ttsSpeed = speed;
      localStorage.setItem(TTS_SPEED_KEY, String(speed));
      const label = speed === 1 ? '1x' : speed + 'x';
      const btn = $('tts-speed-btn');
      if (btn) {
        btn.textContent = label;
        btn.classList.toggle('speed-active', speed !== 1);
      }
      // Apply to any currently playing audio
      if (_vipAudio) _vipAudio.playbackRate = speed;
    }

    // Restore persisted speed on boot
    applyTTSSpeed(_ttsSpeed);

    // ── Speed picker popup ────────────────────────────────────────
    (function () {
      const btn = $('tts-speed-btn');
      if (!btn) return;

      // Build the popup once and append to body
      const menu = document.createElement('div');
      menu.id = 'tts-speed-menu';
      menu.className = 'tts-speed-menu hidden';
      menu.setAttribute('role', 'listbox');
      menu.setAttribute('aria-label', 'Playback speed');

      TTS_SPEED_STEPS.forEach((s) => {
        const opt = document.createElement('button');
        opt.className = 'tts-speed-option';
        opt.setAttribute('role', 'option');
        opt.setAttribute('data-speed', String(s));
        opt.textContent = s === 1 ? '1x  Normal' : s + 'x';
        opt.addEventListener('click', (e) => {
          e.stopPropagation();
          applyTTSSpeed(s);
          closeSpeedMenu();
        });
        menu.appendChild(opt);
      });

      document.body.appendChild(menu);

      function updateMenuSelection() {
        menu.querySelectorAll('.tts-speed-option').forEach((o) => {
          o.classList.toggle('selected', parseFloat(o.dataset.speed) === _ttsSpeed);
        });
      }

      function openSpeedMenu() {
        updateMenuSelection();
        menu.classList.remove('hidden');
        // Position above the button
        const rect = btn.getBoundingClientRect();
        menu.style.left = (rect.left + rect.width / 2 - menu.offsetWidth / 2) + 'px';
        menu.style.top  = (rect.top - menu.offsetHeight - 8) + 'px';
        // Re-position after paint in case offsetWidth/Height was 0
        requestAnimationFrame(() => {
          const r = btn.getBoundingClientRect();
          menu.style.left = (r.left + r.width / 2 - menu.offsetWidth / 2) + 'px';
          menu.style.top  = (r.top - menu.offsetHeight - 8) + 'px';
        });
        btn.setAttribute('aria-expanded', 'true');
      }

      function closeSpeedMenu() {
        menu.classList.add('hidden');
        btn.setAttribute('aria-expanded', 'false');
      }

      btn.setAttribute('aria-haspopup', 'listbox');
      btn.setAttribute('aria-expanded', 'false');

      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        menu.classList.contains('hidden') ? openSpeedMenu() : closeSpeedMenu();
      });

      // Close when clicking outside
      document.addEventListener('click', () => closeSpeedMenu());
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeSpeedMenu();
      });
    })();

    // ── Seek on click / drag ──────────────────────────────────────
    const _ttsTrack = $('tts-track');
    if (_ttsTrack) {
      function seekFromEvent(e) {
        if (!ttsState.active) return;
        const rect = _ttsTrack.getBoundingClientRect();
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const fraction = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
        const total = _ttsTotal;
        if (!total) return;

        const targetParaIdx = Math.min(Math.floor(fraction * total), total - 1);
        const withinFrac    = (fraction * total) - targetParaIdx;
        const audio = _vipAudio;

        if (targetParaIdx !== ttsState.idx) {
          // Jump to a different paragraph
          if (ttsState.paused) {
            // Will resume at new paragraph
            ttsState.paused = false;
          }
          speakParagraph(targetParaIdx);
        } else if (audio && isFinite(audio.duration) && audio.duration > 0) {
          // Same paragraph — seek within
          audio.currentTime = withinFrac * audio.duration;
          setTTSProgress(ttsState.idx, audio.currentTime, audio);
        }
      }

      let _ttsPointerDown = false;
      _ttsTrack.addEventListener('pointerdown', (e) => {
        if (!ttsState.active) return;
        _ttsPointerDown = true;
        _ttsTrack.classList.add('tts-dragging');
        _ttsTrack.setPointerCapture(e.pointerId);
        seekFromEvent(e);
      });
      _ttsTrack.addEventListener('pointermove', (e) => {
        if (!_ttsPointerDown) return;
        seekFromEvent(e);
      });
      _ttsTrack.addEventListener('pointerup', (e) => {
        if (!_ttsPointerDown) return;
        _ttsPointerDown = false;
        _ttsTrack.classList.remove('tts-dragging');
        seekFromEvent(e);
      });
      _ttsTrack.addEventListener('pointercancel', () => {
        _ttsPointerDown = false;
        _ttsTrack.classList.remove('tts-dragging');
      });
    }

    // Language toggle buttons
    const langBar = $('story-lang-bar');
    if (langBar) {
      langBar.addEventListener('click', (e) => {
        const btn = e.target.closest('.story-lang-btn');
        if (!btn) return;
        setStoryLang(btn.dataset.lang);
      });
    }
    // ────────────────────────────────────────────────────

    // Mini player — info row opens full sheet; controls don't
    $('mini-row').addEventListener('click', openPlayerSheet);
    $('mini-play').addEventListener('click', (e) => { e.stopPropagation(); togglePlay(); });
    $('mini-next').addEventListener('click', (e) => { e.stopPropagation(); next(); });
    $('mini-prev').addEventListener('click', (e) => { e.stopPropagation(); prev(); });

    // Sheet
    $('sheet-close').addEventListener('click', closePlayerSheet);
    $('sheet-handle').addEventListener('click', closePlayerSheet);
    $('sheet-play').addEventListener('click', togglePlay);
    $('sheet-next').addEventListener('click', () => next());
    $('sheet-prev').addEventListener('click', prev);
    $('sheet-loop').addEventListener('click', toggleLoop);
    $('sheet-shuffle').addEventListener('click', toggleShuffle);
    $('sheet-queue').addEventListener('click', () => { closePlayerSheet(); switchTab('queue'); });
    $('sheet-lyrics-btn').addEventListener('click', () => {
      const t = state.trackById[state.currentTrackId];
      if (t) openLyricsSheet(t);
    });
    $('mini-lyrics-btn').addEventListener('click', (e) => {
      e.stopPropagation(); // don't open the full player sheet
      const t = state.trackById[state.currentTrackId];
      if (t) openLyricsSheet(t);
    });
    $('lyrics-sheet-close').addEventListener('click', closeLyricsSheet);
    $('lyrics-sheet-handle').addEventListener('click', closeLyricsSheet);
    $('sheet-add-to').addEventListener('click', () => {
      if (!state.currentTrackId) return;
      openPlaylistPicker(state.currentTrackId);
    });
    // Sheet seek
    const seek = $('sheet-seek');
    seek.addEventListener('input', (e) => {
      seek.dataset.scrubbing = '1';
      seek.style.setProperty('--seek-pct', (e.target.value / 10) + '%');
    });
    seek.addEventListener('change', (e) => {
      delete seek.dataset.scrubbing;
      if (audio.duration && !isNaN(audio.duration)) {
        audio.currentTime = (e.target.value / 1000) * audio.duration;
      }
    });

    // Mini seek
    const miniSeek = $('mini-seek');
    miniSeek.addEventListener('click', (e) => e.stopPropagation());
    miniSeek.addEventListener('input', (e) => {
      e.stopPropagation();
      miniSeek.dataset.scrubbing = '1';
      miniSeek.style.setProperty('--seek-pct', (e.target.value / 10) + '%');
    });
    miniSeek.addEventListener('change', (e) => {
      delete miniSeek.dataset.scrubbing;
      if (audio.duration && !isNaN(audio.duration)) {
        audio.currentTime = (e.target.value / 1000) * audio.duration;
      }
    });

    // Skip ±15s (sheet)
    $('sheet-back15').addEventListener('click', () => skip(-15));
    $('sheet-fwd15').addEventListener('click', () => skip(15));

    // Skip ±15s (mini)
    $('mini-back15').addEventListener('click', (e) => { e.stopPropagation(); skip(-15); });
    $('mini-fwd15').addEventListener('click', (e) => { e.stopPropagation(); skip(15); });

    // Shuffle / loop toggles (mini)
    $('mini-shuffle').addEventListener('click', (e) => { e.stopPropagation(); toggleShuffle(); });
    $('mini-loop').addEventListener('click', (e) => { e.stopPropagation(); toggleLoop(); });

    // Volume slider
    const volSlider = $('volume-slider');
    volSlider.style.setProperty('--vol-pct', '100%');
    volSlider.addEventListener('input', (e) => {
      const v = e.target.value / 100;
      audio.volume = v;
      volSlider.style.setProperty('--vol-pct', e.target.value + '%');
    });

    // Library view toggle
    $('view-toggle-btn').addEventListener('click', () => {
      state.libraryView = state.libraryView === 'list' ? 'grid' : 'list';
      persist('libraryView');
      renderLibrary();
    });

    setupSheetSwipe();
    setupPullToRefresh();

    // Track menu
    document.querySelectorAll('#track-menu .modal-item').forEach((btn) => {
      btn.addEventListener('click', () => {
        const action = btn.dataset.action;
        if (action === 'cancel') { closeModal('track-menu'); return; }
        handleTrackMenuAction(action);
      });
    });
    $('track-menu').addEventListener('click', (e) => { if (!e.target.closest('.modal-sheet')) closeModal('track-menu'); });

    // Picker
    $('picker-new').addEventListener('click', () => {
      const pendingId = state.pendingTrackId;
      closeModal('picker-modal');
      openPrompt('New playlist', 'My playlist', '', (v) => {
        const p = createPlaylist(v);
        if (pendingId) addToPlaylist(p.id, pendingId);
        toast(`Added to "${p.name}"`);
      });
    });
    document.querySelectorAll('#picker-modal [data-action="cancel-picker"]').forEach((b) =>
      b.addEventListener('click', () => closeModal('picker-modal'))
    );
    $('picker-modal').addEventListener('click', (e) => { if (!e.target.closest('.modal-sheet')) closeModal('picker-modal'); });

    // Modal backdrops
    $('confirm-modal').addEventListener('click', (e) => { if (!e.target.closest('.modal-sheet')) closeModal('confirm-modal'); });
    $('prompt-modal').addEventListener('click', (e) => { if (!e.target.closest('.modal-sheet')) closeModal('prompt-modal'); });

    // Keyboard shortcuts (desktop)
    document.addEventListener('keydown', (e) => {
      if (e.target.matches('input, textarea')) return;
      if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
      else if (e.code === 'ArrowRight' && e.shiftKey) next();
      else if (e.code === 'ArrowLeft' && e.shiftKey) prev();
      else if (e.key.toLowerCase() === 'l') toggleLoop();
      else if (e.key.toLowerCase() === 's') toggleShuffle();
      else if (e.code === 'ArrowRight' && !e.shiftKey) skip(15);
      else if (e.code === 'ArrowLeft' && !e.shiftKey) skip(-15);
      else if (e.key === 'Escape') {
        if (!$('player-sheet').classList.contains('hidden')) closePlayerSheet();
      }
    });

    updateLoopUI();
    updateShuffleUI();
  } // end _setupEventListenersInner

  function setupSheetSwipe() {
    const sheet = $('player-sheet');
    let startY = 0;
    let currentY = 0;
    let active = false;
    const onStart = (e) => {
      const target = e.target;
      if (!target.closest('.sheet-handle, .sheet-close, .sheet-art, .sheet-info')) return;
      active = true;
      startY = (e.touches ? e.touches[0].clientY : e.clientY);
      currentY = startY;
      sheet.style.transition = 'none';
    };
    const onMove = (e) => {
      if (!active) return;
      currentY = (e.touches ? e.touches[0].clientY : e.clientY);
      const dy = Math.max(0, currentY - startY);
      sheet.style.transform = `translateY(${dy}px)`;
    };
    const onEnd = () => {
      if (!active) return;
      active = false;
      const dy = Math.max(0, currentY - startY);
      sheet.style.transition = '';
      sheet.style.transform = '';
      if (dy > 100) closePlayerSheet();
    };
    sheet.addEventListener('touchstart', onStart, { passive: true });
    sheet.addEventListener('touchmove', onMove, { passive: true });
    sheet.addEventListener('touchend', onEnd);
    sheet.addEventListener('touchcancel', onEnd);
  }

  // ============== PULL-TO-REFRESH ==============
  function setupPullToRefresh() {
    const content   = $('content');
    const indicator = $('ptr-indicator');
    if (!content || !indicator) return;

    const THRESHOLD = 72;   // px of raw drag needed to trigger
    const DAMP      = 0.42; // how much resistance to apply (< 1 = slower than finger)
    const MAX_PULL  = 100;  // cap how far indicator travels
    const HIDE_Y    = -80;  // translateY when fully hidden (slides under topbar)
    const HOLD_Y    = 12;   // translateY when spinning (held in view)

    let startY    = 0;
    let pulling   = false;
    let triggered = false;

    function applyPull(rawDy) {
      const dy = Math.min(rawDy * DAMP, MAX_PULL);
      // No JS transition while dragging — we update every frame
      indicator.style.transition = 'none';
      indicator.style.transform  = `translateX(-50%) translateY(${HIDE_Y + dy}px)`;
      indicator.classList.toggle('ptr-ready', dy >= THRESHOLD * DAMP);
    }

    function snapBack() {
      indicator.style.transition = 'transform .25s ease';
      indicator.style.transform  = `translateX(-50%) translateY(${HIDE_Y}px)`;
      indicator.classList.remove('ptr-ready', 'ptr-spinning');
      pulling   = false;
      triggered = false;
    }

    function triggerRefresh() {
      triggered = true;
      indicator.classList.remove('ptr-ready');
      indicator.classList.add('ptr-spinning');
      indicator.style.transition = 'transform .2s ease';
      indicator.style.transform  = `translateX(-50%) translateY(${HOLD_Y}px)`;
      // Force-reload bypasses all caches (equivalent to hard refresh)
      setTimeout(() => location.reload(true), 520);
    }

    content.addEventListener('touchstart', (e) => {
      if (triggered) return;
      if (content.scrollTop > 0) return;
      // Ignore touches that start inside floating sheets / player / TTS bar
      if (e.target.closest('.player-sheet, .prompt-sheet, .settings-sheet, .story-tts-bar, .modal-overlay')) return;
      startY  = e.touches[0].clientY;
      pulling = false; // wait for first move to confirm downward direction
    }, { passive: true });

    content.addEventListener('touchmove', (e) => {
      if (triggered) return;
      if (content.scrollTop > 0) { pulling = false; return; }
      const dy = e.touches[0].clientY - startY;
      if (dy <= 0) { pulling = false; return; }
      // Confirmed downward drag — activate PTR
      if (!pulling) pulling = true;
      e.preventDefault(); // block native scroll/bounce while PTR is active
      applyPull(dy);
    }, { passive: false });

    content.addEventListener('touchend', () => {
      if (!pulling || triggered) return;
      // Read how far the indicator has moved
      const match  = (indicator.style.transform || '').match(/translateY\((-?[\d.]+)px\)/);
      const curY   = match ? parseFloat(match[1]) : HIDE_Y;
      const pullDy = curY - HIDE_Y; // how many px it's been pushed down
      if (pullDy >= THRESHOLD * DAMP) {
        triggerRefresh();
      } else {
        snapBack();
      }
    });

    content.addEventListener('touchcancel', () => {
      if (pulling && !triggered) snapBack();
    });
  }

  // ============== ONBOARDING ==============
  function checkOnboarding() {
    try {
      if (localStorage.getItem('drift.onboardingDone')) return;
    } catch { return; }
    showOnboarding(false);
  }

  function showOnboarding(guestMode) {
    const overlay = $('onboarding-overlay');
    const track   = $('onboarding-track');
    if (!overlay || !track) return;

    overlay.classList.remove('hidden');
    let currentScreen = 2;

    // ── Confetti burst on "You're all set" screen ─────────────
    // Loaded lazily the first time screen-4 is shown. Playing it
    // on overlay-open caused a top→bottom positioning flip because
    // the Lottie SVG was sized against a hidden container.
    let confettiAnim = null;
    function fireConfetti() {
      const container = $('ob-confetti');
      if (!container || typeof lottie === 'undefined') return;
      if (confettiAnim) {
        confettiAnim.stop();
        confettiAnim.play();
        return;
      }
      confettiAnim = lottie.loadAnimation({
        container,
        renderer: 'svg',
        loop: false,
        autoplay: false,
        path: 'confetti.json',
      });
      confettiAnim.addEventListener('data_ready', function onReady() {
        confettiAnim.removeEventListener('data_ready', onReady);
        confettiAnim.setSpeed(0.75);
        confettiAnim.play();
      });
    }

    if (guestMode) {
      // 2-screen guest flow: Welcome → Limited features
      overlay.classList.add('ob-guest-mode');
      const s3 = $('ob-screen-3');
      const s4 = $('ob-screen-4');
      const sg = $('ob-screen-guest');
      if (s3) s3.style.display = 'none';
      if (s4) s4.style.display = 'none';
      if (sg) sg.classList.remove('hidden');
    }

    // Update dots: screen 2 has 3 hardcoded dots — drop the 3rd in guest mode (2-screen flow)
    if (guestMode) {
      const scr2 = $('ob-screen-2');
      if (scr2) {
        const dots = scr2.querySelectorAll('.ob-dot');
        if (dots.length >= 3) dots[2].remove();
      }
    }

    function goTo(n) {
      currentScreen = n;
      // Screen 2 is first in track (offset 0), screen 3 is second, etc.
      const screenW = overlay.clientWidth || window.innerWidth;
      track.style.transform = `translateX(-${(n - 2) * screenW}px)`;
      if (n === 4) fireConfetti();
    }

    function completeOnboarding() {
      try { localStorage.setItem('drift.onboardingDone', '1'); } catch {}
      overlay.classList.add('ob-fade-out');
      overlay.addEventListener('animationend', () => {
        overlay.classList.add('hidden');
        overlay.classList.remove('ob-fade-out');
      }, { once: true });
    }

    // Pre-populate from existing profile (returning user on a new device/domain)
    const existingProfile = getChildProfile();
    let _obGender = existingProfile.gender || '';

    function prefillObProfile(cp) {
      if (cp.name)   $('ob-name-input').value = cp.name;
      if (cp.dob)    $('ob-dob-input').value  = cp.dob;
      if (cp.gender) {
        _obGender = cp.gender;
        overlay.querySelectorAll('.ob-gender-btn').forEach((b) =>
          b.classList.toggle('active', b.dataset.gender === cp.gender)
        );
      }
    }
    if (existingProfile.name) prefillObProfile(existingProfile);

    // Also try Firestore in background (handles cross-device case)
    if (state.user) {
      window.fbDb.doc(`users/${state.user.uid}/settings/childProfile`).get()
        .then((doc) => {
          if (!doc.exists) return;
          const { name = '', gender = '', dob = '' } = doc.data();
          if (name) prefillObProfile({ name, gender, dob });
        })
        .catch(() => {});
    }

    // Gender selection
    overlay.querySelectorAll('.ob-gender-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        overlay.querySelectorAll('.ob-gender-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        _obGender = btn.dataset.gender;
      });
    });

    // Screen 2 → 3 (goes to guest screen in guest mode, child profile otherwise)
    $('ob-next-2').addEventListener('click', () => goTo(3));

    if (guestMode) {
      // Guest screen: "Explore the app" → dismiss onboarding
      const guestEnterBtn = $('ob-guest-enter');
      if (guestEnterBtn) {
        guestEnterBtn.addEventListener('click', () => {
          completeOnboarding();
        });
      }
      // Guest screen: "Create a free account" → go back to sign-in screen
      const guestSignupBtn = $('ob-guest-signup');
      if (guestSignupBtn) {
        guestSignupBtn.addEventListener('click', () => {
          overlay.classList.add('hidden');
          promptGuestSignIn();
        });
      }
    } else {
      // Screen 3 → 4: save profile
      $('ob-next-3').addEventListener('click', () => {
        const name = ($('ob-name-input').value || '').trim();
        const dob  = ($('ob-dob-input').value  || '').trim();
        if (name) {
          saveChildProfile({ name, gender: _obGender, dob });
          refreshChildChip();
          // Pre-fill settings modal fields so they feel consistent on first open
          if ($('child-name-input')) $('child-name-input').value = name;
          if ($('child-dob-input'))  $('child-dob-input').value  = dob;
          document.querySelectorAll('.child-gender-btn').forEach((b) =>
            b.classList.toggle('active', b.dataset.gender === _obGender)
          );
          // Personalise the SOTD hint on screen 4
          const hintEl = $('ob-hint-sotd');
          if (hintEl) {
            const firstName = name.split(' ')[0];
            hintEl.innerHTML = `<strong>Check the Home tab</strong> for today's personalised story for ${firstName}`;
          }
        }
        goTo(4);
      });

      // Screen 3 skip
      $('ob-skip-3').addEventListener('click', () => goTo(4));

      // Screen 4 finish
      $('ob-finish').addEventListener('click', () => {
        completeOnboarding();
        // If profile was saved, kick off SOTD now that we have data
        if (getChildProfile().name) loadStoryOfDay();
      });
    }

    goTo(2);
  }

  // ============== GO ==============
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // ============== AUDIOBOOKS ==============
  const AB_FOLDER_ID = '1yJRpcfeWq-hqWf47ZEytfOsHmg1br9aO';
  const AB_SPEED_STEPS = [0.75, 1, 1.25, 1.5, 1.75, 2];
  const AB_VIRTUAL_CHAPTER_SECS = 1800; // 30 minutes — split threshold for single-file books
  let _abLibrary   = null;   // { books: [{ id, name, chapters, coverFileId }] }
  let _abBook      = null;   // currently open book
  let _abChapterIdx = 0;     // currently playing chapter index
  let _abAudio     = null;   // separate Audio element — never touches music player
  let _abPlaying   = false;
  let _abSpeed     = 1;
  let _abProgress  = {};     // { [bookId]: { [fileId]: { position, duration } } } — in-memory cache
  let _abSaveTimer = null;

  function applyAudiobooksTab() {
    const btn = $('audiobooks-tab-btn');
    if (btn) btn.classList.toggle('hidden', !state.audiobooksEnabled);
  }

  // ── Firestore helpers ──────────────────────────────────────────
  function abProgressRef(bookId) {
    if (!state.user) return null;
    return window.fbDb.doc(`users/${state.user.uid}/audiobookProgress/${bookId}`);
  }
  function abSettingsRef() {
    if (!state.user) return null;
    return window.fbDb.doc(`users/${state.user.uid}/settings/appFeatures`);
  }

  async function syncAudiobooksSettingFromFirestore() {
    if (!state.user) return;
    try {
      const doc = await abSettingsRef().get();
      if (doc.exists && typeof doc.data().audiobooksEnabled === 'boolean') {
        const remote = doc.data().audiobooksEnabled;
        if (remote !== state.audiobooksEnabled) {
          state.audiobooksEnabled = remote;
          localStorage.setItem(LS.audiobooksEnabled, remote ? '1' : '0');
          applyAudiobooksTab();
          const abToggleEl = $('audiobooks-toggle');
          if (abToggleEl) abToggleEl.setAttribute('aria-checked', remote ? 'true' : 'false');
        }
      }
    } catch (e) { console.warn('abSettings sync failed', e); }
  }

  async function syncAudiobookProgressFromFirestore() {
    if (!state.user) return;
    try {
      // Load the entire progress collection in one batch
      const snap = await window.fbDb
        .collection(`users/${state.user.uid}/audiobookProgress`)
        .get();
      snap.docs.forEach(doc => {
        _abProgress[doc.id] = doc.data().chapters || {};
      });
      // If audiobooks tab is currently visible, re-render so Continue Listening shows correctly
      if (state.currentTab === 'audiobooks' && $('view-audiobooks') &&
          !$('view-audiobooks').classList.contains('hidden')) {
        renderAudiobookLibrary();
      }
    } catch (e) { console.warn('abProgress sync failed', e); }
  }

  function saveAudiobooksSettingToFirestore() {
    if (!state.user) return;
    abSettingsRef().set({ audiobooksEnabled: state.audiobooksEnabled }, { merge: true })
      .catch(e => console.warn('abSettings save failed', e));
  }

  async function loadAbProgress(bookId) {
    // If already in memory (either from sync or previous load), use it
    if (_abProgress[bookId] !== undefined) return _abProgress[bookId];
    // Mark as loaded (empty) so we don't duplicate-fetch
    _abProgress[bookId] = {};
    if (!state.user) return {};
    try {
      const doc = await abProgressRef(bookId).get();
      _abProgress[bookId] = doc.exists ? (doc.data().chapters || {}) : {};
    } catch { _abProgress[bookId] = {}; }
    return _abProgress[bookId];
  }

  function saveAbProgress(bookId, fileId, position, duration) {
    // Always update memory immediately — this is what renderAudiobookLibrary reads
    if (!_abProgress[bookId]) _abProgress[bookId] = {};
    _abProgress[bookId][fileId] = { position, duration };
    // Debounce the Firestore write
    clearTimeout(_abSaveTimer);
    _abSaveTimer = setTimeout(() => flushAbProgressToFirestore(bookId), 5000);
  }

  function flushAbProgressToFirestore(bookId) {
    clearTimeout(_abSaveTimer);
    const id = bookId || _abBook?.id;
    if (!state.user || !id || !_abProgress[id]) return;
    const ref = abProgressRef(id);
    if (ref) ref.set({ chapters: _abProgress[id] }, { merge: true })
      .catch(e => console.warn('abProgress flush failed', e));
  }

  // ── Drive loading ─────────────────────────────────────────────
  function isImage(file) {
    const name = (file.name || '').toLowerCase();
    return name.endsWith('.jpg') || name.endsWith('.jpeg') || name.endsWith('.png') || name.endsWith('.webp');
  }

  // Recursively finds all folders containing audio files (up to maxDepth levels deep).
  // bookFolder is always the top-level folder — its name is the book title.
  // rootFiles are the top-level folder's files (used for cover image lookup).
  async function _findBookFolders(folder, depth, maxDepth, bookFolder = null, rootFiles = null) {
    const rootFolder = bookFolder || folder;
    if (depth > maxDepth) return [];
    try {
      const children = await listAllChildren(folder.id);
      const topFiles  = rootFiles || children; // top-level files for cover lookup
      const audio = children.filter(isAudio);
      if (audio.length) {
        // Search for cover in both the root folder AND the current (audio) folder
        // so images stored anywhere in the book's folder tree are found
        const combinedFiles = topFiles === children
          ? children
          : [...topFiles, ...children];
        return [{ folder: rootFolder, audio, allFiles: combinedFiles }];
      }
      const subFolders = children.filter(isFolder);
      if (!subFolders.length) return [];
      const nested = await Promise.all(
        subFolders.map(sf => _findBookFolders(sf, depth + 1, maxDepth, rootFolder, topFiles))
      );
      return nested.flat();
    } catch { return []; }
  }

  async function loadAudiobookLibrary(forceRefresh = false) {
    if (_abLibrary && !forceRefresh) return _abLibrary;
    try {
      const topFolders = (await listAllChildren(AB_FOLDER_ID)).filter(isFolder);

      // Recursively find every folder that actually contains audio files.
      // This handles any nesting depth (flat, one level, two levels, etc.)
      const bookResults = (await Promise.all(
        topFolders.map(folder => _findBookFolders(folder, 0, 3))
      )).flat();

      const books = bookResults.map(({ folder, audio, allFiles }) => {
        const sorted = [...audio].sort((a, b) => naturalCompare(a.name, b.name));
        const coverFile = allFiles.find(isImage);
        return {
          id: folder.id,
          name: folder.name,
          chapters: sorted.map(f => ({
            id: f.id,
            name: cleanTrackName(f.name),
            rawName: f.name,
          })),
          coverFileId: coverFile ? coverFile.id : null,
        };
      });

      books.sort((a, b) => naturalCompare(a.name, b.name));
      _abLibrary = { books };
      return _abLibrary;
    } catch (e) {
      console.warn('audiobook library load failed', e);
      return { books: [] };
    }
  }

  // ── Cover URL ─────────────────────────────────────────────────
  function makeAbBook(folder, allFiles, audioFiles) {
    const chapters = [...audioFiles].sort((a, b) => naturalCompare(a.name, b.name));
    const coverFile = allFiles.find(isImage);
    return {
      id: folder.id,
      name: folder.name,
      chapters: chapters.map(f => ({
        id: f.id,
        name: cleanTrackName(f.name),
        rawName: f.name,
      })),
      coverFileId: coverFile ? coverFile.id : null,
    };
  }

  function abCoverUrl(fileId) {
    return `https://drive.google.com/thumbnail?id=${fileId}&sz=w400`;
  }

  // ── Deterministic cover gradient from book name ───────────────
  function abCoverGradient(name) {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xffffffff;
    const hue = Math.abs(h) % 360;
    const hue2 = (hue + 40) % 360;
    return `linear-gradient(135deg, hsl(${hue},45%,20%), hsl(${hue2},50%,30%))`;
  }

  // ── Progress helpers ──────────────────────────────────────────

  // For single-file books split into virtual chapters, progress is stored under
  // "realId_vp0", "realId_vp1", … keys instead of the real chapter id.
  // This helper returns all progress entries for a given real chapter id,
  // including any virtual-part entries.
  function _chapterProgressEntries(prog, realId) {
    const entries = [];
    if (prog[realId]) entries.push(prog[realId]);
    Object.keys(prog).forEach(k => {
      if (k.startsWith(realId + '_vp')) entries.push(prog[k]);
    });
    return entries;
  }

  function abBookProgress(bookId, book) {
    const prog = _abProgress[bookId] || {};
    const totalChapters = book.chapters.length;
    if (totalChapters === 0) return 0;

    // For single-file books split into virtual 30-min parts, progress is stored
    // under "realId_vp0", "realId_vp1", … with position relative to part start.
    // Convert to an absolute position: partIndex * 1800 + relativePosition.
    // Total duration comes from the raw (pre-virtual) chapter entry when available.
    if (totalChapters === 1) {
      const realId = book.chapters[0].id;

      // Collect virtual-part entries keyed by part index
      const vpMap = {};
      const escapedId = realId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      Object.keys(prog).forEach(k => {
        const m = k.match(new RegExp(`^${escapedId}_vp(\\d+)$`));
        if (m && prog[k] && prog[k].duration) vpMap[parseInt(m[1])] = prog[k];
      });
      const vpIndices = Object.keys(vpMap).map(Number);

      if (vpIndices.length > 0) {
        // Sum actual listened time across ALL parts (handles skipped parts —
        // e.g. parts 1,2,4,5 played but 3 skipped should reflect ~80%, not 40%).
        let listened = 0, maxIdx = 0;
        vpIndices.forEach(i => {
          const e = vpMap[i];
          listened += Math.min(e.position || 0, e.duration || AB_VIRTUAL_CHAPTER_SECS);
          if (i > maxIdx) maxIdx = i;
        });

        // Total duration from the raw entry (set on expansion); fall back to an
        // estimate from the furthest part if not yet persisted.
        const rawEntry = prog[realId];
        const totalDur = (rawEntry && rawEntry.duration > 0)
          ? rawEntry.duration
          : (maxIdx + 1) * AB_VIRTUAL_CHAPTER_SECS;
        return totalDur > 0 ? Math.min(listened / totalDur, 1) : 0;
      }

      // No virtual entries yet — use raw entry (absolute position in full file)
      const rawEntry = prog[realId];
      if (rawEntry && rawEntry.duration > 0) {
        return Math.min((rawEntry.position || 0) / rawEntry.duration, 1);
      }
      return 0;
    }

    // Multi-chapter books: use original logic.
    let knownDur = 0, knownCount = 0;
    book.chapters.forEach(ch => {
      const p = prog[ch.id];
      if (p && p.duration) { knownDur += p.duration; knownCount++; }
    });
    const avgDur = knownCount > 0 ? knownDur / knownCount : 1;
    const estimatedTotal = totalChapters * avgDur;

    let totalPos = 0;
    book.chapters.forEach(ch => {
      const p = prog[ch.id];
      if (p) totalPos += Math.min(p.position || 0, p.duration || avgDur);
    });

    return estimatedTotal > 0 ? totalPos / estimatedTotal : 0;
  }

  function abChapterPct(bookId, fileId) {
    const p = (_abProgress[bookId] || {})[fileId];
    if (!p || !p.duration) return 0;
    return Math.min(p.position / p.duration, 1);
  }

  function abLastChapterIdx(book) {
    // find the first incomplete chapter, or last if all done
    const prog = _abProgress[book.id] || {};
    for (let i = 0; i < book.chapters.length; i++) {
      const p = prog[book.chapters[i].id];
      if (!p || !p.duration || p.position / p.duration < 0.95) return i;
    }
    return 0;
  }

  // Split a single-file book into virtual 30-min chapters.
  // Virtual chapters share the same audio file (realId) but have startTime/endTime offsets.
  // Progress is stored relative to the chapter start so abChapterPct works unchanged.
  function expandToVirtualChapters(realChapter, totalDuration) {
    const count = Math.ceil(totalDuration / AB_VIRTUAL_CHAPTER_SECS);
    const chapters = [];
    for (let i = 0; i < count; i++) {
      chapters.push({
        id:        `${realChapter.id}_vp${i}`,
        name:      `Part ${i + 1}`,
        realId:    realChapter.id,
        startTime: i * AB_VIRTUAL_CHAPTER_SECS,
        endTime:   Math.min((i + 1) * AB_VIRTUAL_CHAPTER_SECS, totalDuration),
      });
    }
    return chapters;
  }

  // ── Render main listing ───────────────────────────────────────
  let _abRenderPending = false;
  async function renderAudiobookLibrary() {
    if (_abRenderPending) return;
    _abRenderPending = true;
    try { await _renderAudiobookLibrary(); } finally { _abRenderPending = false; }
  }
  async function _renderAudiobookLibrary() {
    const grid = $('ab-books-grid');
    const continueScroll = $('ab-continue-scroll');
    if (!grid || !continueScroll) return;

    // Clear all previous state (including any injected empty-state elements)
    grid.innerHTML = '';
    continueScroll.innerHTML = '';
    continueScroll.style.display = '';
    continueScroll.parentNode.querySelectorAll('.ab-continue-empty').forEach(el => el.remove());

    // Show skeletons while loading
    for (let i = 0; i < 4; i++) {
      const sk = document.createElement('div');
      sk.className = 'ab-book-skeleton';
      grid.appendChild(sk);
    }

    const lib = await loadAudiobookLibrary();
    if (!lib.books.length) {
      grid.innerHTML = '<div style="padding:20px;color:var(--text3);font-size:13px;grid-column:1/-1">No audiobooks found in the library.</div>';
      return;
    }

    // Load progress for all books
    await Promise.all(lib.books.map(b => loadAbProgress(b.id)));

    // Count header
    const countEl = $('ab-books-count');
    if (countEl) countEl.textContent = `${lib.books.length} book${lib.books.length !== 1 ? 's' : ''}`;

    // Continue Listening
    const inProgress = lib.books.filter(b => {
      const pct = abBookProgress(b.id, b);
      return pct > 0 && pct < 0.95;
    });
    const continueHeader = $('ab-continue-header');
    if (inProgress.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'ab-continue-empty';
      empty.innerHTML = `<span style="font-size:28px;flex-shrink:0">🎧</span><span>No books started yet. <strong>Browse below →</strong> to begin your first listen.</span>`;
      continueScroll.parentNode.insertBefore(empty, continueScroll);
      continueScroll.style.display = 'none';
    } else {
      inProgress.forEach(book => {
        const pct = abBookProgress(book.id, book);
        const pctPct = Math.round(pct * 100);
        const lastIdx = abLastChapterIdx(book);
        const card = document.createElement('div');
        card.className = 'ab-continue-card';
        card.innerHTML = `
          <div class="ab-continue-cover">
            ${book.coverFileId
              ? `<img src="${abCoverUrl(book.coverFileId)}" alt="${book.name}" loading="lazy">`
              : `<div class="ab-cover-placeholder" style="background:${abCoverGradient(book.name)}">📖</div>`}
          </div>
          <div class="ab-continue-bar-wrap"><div class="ab-continue-bar-fill" style="width:${pctPct}%"></div></div>
          <div class="ab-continue-info">
            <div class="ab-continue-title">${book.name}</div>
            <div class="ab-continue-meta">${pctPct}% done</div>
          </div>
          <button class="ab-continue-delete-btn" title="Remove from Continue Listening">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>
          </button>`;
        card.querySelector('.ab-continue-delete-btn').addEventListener('click', e => {
          e.stopPropagation();
          openConfirm(
            'Remove reading progress?',
            `This will permanently delete your progress for "${book.name}", including which chapters you've listened to and how far you got. This cannot be undone.`,
            async () => {
              delete _abProgress[book.id];
              const ref = abProgressRef(book.id);
              if (ref) ref.delete().catch(e => console.warn('abProgress delete failed', e));
              card.remove();
              // Show empty state if no more in-progress books
              if (!continueScroll.querySelector('.ab-continue-card')) {
                const empty = document.createElement('div');
                empty.className = 'ab-continue-empty';
                empty.innerHTML = `<span style="font-size:28px;flex-shrink:0">🎧</span><span>No books started yet. <strong>Browse below →</strong> to begin your first listen.</span>`;
                continueScroll.parentNode.insertBefore(empty, continueScroll);
                continueScroll.style.display = 'none';
              }
            },
            { confirmLabel: 'Delete Progress', danger: true }
          );
        });
        card.addEventListener('click', () => openAudiobook(book, lastIdx));
        continueScroll.appendChild(card);
      });
    }

    // Books grid
    grid.innerHTML = '';
    lib.books.forEach(book => {
      const pct = abBookProgress(book.id, book);
      const pctPct = Math.round(pct * 100);
      const done = pct >= 0.95;
      const circumference = 75.4;
      const offset = circumference * (1 - Math.min(pct, 1));
      const tile = document.createElement('div');
      tile.className = 'ab-book-tile';
      const ringHtml = pctPct > 0 ? `
        <div class="ab-progress-ring">
          <svg viewBox="0 0 32 32" width="32" height="32">
            <circle class="ab-ring-bg" cx="16" cy="16" r="12" stroke-dasharray="${circumference}"/>
            <circle class="ab-ring-fill${done ? ' done' : ''}" cx="16" cy="16" r="12"
              stroke-dasharray="${circumference}" stroke-dashoffset="${offset}"/>
          </svg>
          <div class="ab-ring-pct">${done ? '✓' : pctPct + '%'}</div>
        </div>` : '';
      tile.innerHTML = `
        <div class="ab-book-cover">
          ${book.coverFileId
            ? `<img src="${abCoverUrl(book.coverFileId)}" alt="${book.name}" loading="lazy">`
            : `<div class="ab-cover-placeholder" style="background:${abCoverGradient(book.name)}">📖</div>`}
          ${ringHtml}
        </div>
        <div class="ab-book-info">
          <div class="ab-book-title">${book.name}</div>
          <div class="ab-book-meta">${book.chapters.length} chapter${book.chapters.length !== 1 ? 's' : ''}</div>
        </div>`;
      tile.addEventListener('click', () => openAudiobook(book, abLastChapterIdx(book)));
      grid.appendChild(tile);
    });
  }

  // ── Open a book ───────────────────────────────────────────────
  async function openAudiobook(book, startChapterIdx = 0) {
    // Fast path: if this single-file book was opened before, its total duration is
    // cached in Firestore. Load progress and pre-expand to virtual chapters BEFORE
    // any rendering so the hero count + chapter list are split from the first frame
    // (no single-file flash).
    if (book.chapters.length === 1) {
      await loadAbProgress(book.id);
      const cachedDur = (_abProgress[book.id] || {})[book.chapters[0].id]?.duration;
      if (cachedDur && cachedDur > AB_VIRTUAL_CHAPTER_SECS) {
        const vchapters = expandToVirtualChapters(book.chapters[0], cachedDur);
        book = { ...book, chapters: vchapters };
        startChapterIdx = abLastChapterIdx(book);
      }
    }

    _abBook = book;
    _abChapterIdx = startChapterIdx;

    // Render hero with placeholder author while we fetch
    const renderHero = (author) => {
      const hero = $('ab-hero');
      if (!hero) return;
      hero.innerHTML = `
        <div class="ab-hero-cover">
          ${book.coverFileId
            ? `<img src="${abCoverUrl(book.coverFileId)}" alt="${book.name}">`
            : `<div class="ab-cover-placeholder" style="background:${abCoverGradient(book.name)}">📖</div>`}
        </div>
        <div class="ab-hero-info">
          <div class="ab-hero-title">${book.name}</div>
          ${author ? `<div class="ab-hero-author">${author}</div>` : '<div class="ab-hero-author ab-hero-author--loading">Loading…</div>'}
          <div class="ab-hero-stats">
            <div class="ab-hero-stat">
              <div class="ab-hero-stat-val">${book.chapters.length}</div>
              <div class="ab-hero-stat-label">Chapters</div>
            </div>
          </div>
        </div>`;
    };
    renderHero(null);

    // Reset more details section
    const toggle = $('ab-more-details-toggle');
    const body   = $('ab-more-details-body');
    if (toggle) toggle.classList.remove('open');
    if (body)   body.classList.remove('open');
    const descEl = $('ab-description');
    if (descEl) { descEl.textContent = ''; descEl.classList.add('ab-description--loading'); }

    // Fetch book info and update hero + description
    fetchBookInfo(book.name).then(({ author, description }) => {
      // Update author in hero
      const authorEl = $('ab-hero')?.querySelector('.ab-hero-author');
      if (authorEl) {
        if (author) { authorEl.textContent = author; authorEl.classList.remove('ab-hero-author--loading'); }
        else { authorEl.remove(); }
      }
      // Update description
      if (descEl) {
        descEl.classList.remove('ab-description--loading');
        descEl.textContent = description || 'No description available.';
      }
    });

    // Ensure progress is loaded (no-op if the fast path above already loaded it)
    await loadAbProgress(book.id);
    renderAbChapters();

    switchView('view-audiobook-detail');
    $('content').scrollTo({ top: 0, behavior: 'instant' });

    // Load chapter without autoplaying — user taps play to start
    abLoadChapter(_abChapterIdx, false);

    // For single-file books not yet expanded (first open, no cached duration):
    // expand to virtual 30-min chapters once duration is known. Streaming audio
    // often reports duration=Infinity at loadedmetadata and only resolves it later
    // via durationchange, so we listen to both events.
    if (book.chapters.length === 1) {
      const audioEl = abGetAudio();
      let expanded = false;
      const tryExpand = () => {
        if (expanded) return;
        if (_abBook?.id !== book.id) {
          audioEl.removeEventListener('durationchange', tryExpand);
          return;
        }
        const totalDur = audioEl.duration;
        if (!isFinite(totalDur) || totalDur <= AB_VIRTUAL_CHAPTER_SECS) return;
        expanded = true;
        audioEl.removeEventListener('durationchange', tryExpand);
        const vchapters = expandToVirtualChapters(book.chapters[0], totalDur);
        _abBook = { ...book, chapters: vchapters };
        // Persist total file duration under the real chapter id so abBookProgress
        // can compute accurate percentages without knowing the virtual chapter count.
        if (!_abProgress[book.id]) _abProgress[book.id] = {};
        const _rawEntry = _abProgress[book.id][book.chapters[0].id] || {};
        _abProgress[book.id][book.chapters[0].id] = { ..._rawEntry, duration: totalDur };
        flushAbProgressToFirestore(book.id);
        const resumeIdx = abLastChapterIdx(_abBook);
        _abChapterIdx = resumeIdx;
        renderAbChapters();
        const statEl = $('ab-hero')?.querySelector('.ab-hero-stat-val');
        if (statEl) statEl.textContent = vchapters.length;
        const vch = vchapters[resumeIdx];
        const saved = (_abProgress[_abBook.id] || {})[vch.id];
        const absPos = (saved && saved.position > 0 && saved.position < (saved.duration ?? (vch.endTime - vch.startTime)) - 2)
          ? vch.startTime + saved.position : vch.startTime;
        if (absPos > 0) audioEl.currentTime = absPos;
      };
      tryExpand(); // immediate if duration already known
      if (!expanded) audioEl.addEventListener('durationchange', tryExpand);
    }
  }

  // ── Chapter list ──────────────────────────────────────────────
  function renderAbChapters() {
    const container = $('ab-chapters');
    if (!container || !_abBook) return;
    container.innerHTML = `<div class="ab-chapters-heading">Chapters</div>`;
    _abBook.chapters.forEach((ch, idx) => {
      const pct = abChapterPct(_abBook.id, ch.id);
      const pctPct = Math.round(pct * 100);
      const done = pct >= 0.95;
      const isActive = idx === _abChapterIdx;
      const row = document.createElement('div');
      row.className = `ab-chapter-row${isActive ? ' active' : ''}`;
      row.dataset.idx = idx;
      let numContent = done ? '✓' : (isActive ? '▶' : String(idx + 1));
      const realId = ch.realId || ch.id;
      const dlDone = isNative() && isDownloaded(realId);
      const dlIcon = dlDone
        ? `<button class="dl-dot ab-dl-dot" data-fileid="${realId}" aria-label="Remove download" title="Downloaded — tap to remove"></button>`
        : (isNative() ? `<button class="ab-dl-btn" data-fileid="${realId}" aria-label="Download chapter" title="Download">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          </button>` : '');
      row.innerHTML = `
        <div class="ab-chapter-num${done ? ' done' : ''}${isActive ? ' active' : ''}">${numContent}</div>
        <div class="ab-chapter-info">
          <div class="ab-chapter-name${done ? ' done' : ''}${isActive ? ' active' : ''}">${ch.name}</div>
        </div>
        <div class="ab-chapter-pct-wrap">
          <div class="ab-chapter-pct${done ? ' done' : ''}${isActive ? ' active' : ''}">${pctPct > 0 ? pctPct + '%' : ''}</div>
          <div class="ab-chapter-bar"><div class="ab-chapter-bar-fill${done ? ' done' : ''}${isActive ? ' active' : ''}" style="width:${pctPct}%"></div></div>
        </div>
        ${dlIcon}`;
      row.addEventListener('click', (e) => {
        if (e.target.closest('.ab-dl-btn') || e.target.closest('.ab-dl-dot')) return;
        abLoadChapter(idx, true);
      });
      const dlDot = row.querySelector('.ab-dl-dot');
      if (dlDot) {
        dlDot.addEventListener('click', (e) => {
          e.stopPropagation();
          const fid = dlDot.dataset.fileid;
          openConfirm(
            'Remove download?',
            'This chapter will no longer be available offline. You can download it again anytime.',
            async () => {
              await removeDownload(fid);
              renderAbChapters();
              renderDlSettingsSection();
              toast('Download removed');
            },
            { confirmLabel: 'Remove', danger: true }
          );
        });
      }
      const dlBtn = row.querySelector('.ab-dl-btn');
      if (dlBtn) {
        dlBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const fid = dlBtn.dataset.fileid;
          dlBtn.disabled = true;
          dlBtn.innerHTML = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"/><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/></svg>`;
          downloadFile(fid, null)
            .then(() => { toast('Chapter saved for offline'); renderAbChapters(); })
            .catch(() => { dlBtn.disabled = false; toast('Download failed'); });
        });
      }
      container.appendChild(row);
    });
  }

  // ── Player ────────────────────────────────────────────────────
  function abGetAudio() {
    if (!_abAudio) {
      _abAudio = new Audio();
      _abAudio.addEventListener('timeupdate', abOnTimeUpdate);
      _abAudio.addEventListener('ended', abOnEnded);
      _abAudio.addEventListener('play',  () => {
        _abPlaying = true;
        abUpdatePlayBtn();
        // Pause the music player when audiobook starts
        if (!audio.paused) audio.pause();
      });
      _abAudio.addEventListener('pause', () => {
        _abPlaying = false;
        abUpdatePlayBtn();
        // Save progress immediately on any pause (including iOS audio interruptions).
        if (_abBook && _abAudio.currentTime > 2 && _abAudio.duration) {
          const ch = _abBook.chapters[_abChapterIdx];
          if (ch) {
            const chStart = ch.startTime ?? 0;
            const chEnd   = ch.endTime   ?? _abAudio.duration;
            const relPos  = Math.max(0, _abAudio.currentTime - chStart);
            const chDur   = chEnd - chStart;
            saveAbProgress(_abBook.id, ch.id, relPos, chDur);
            flushAbProgressToFirestore(_abBook.id);
          }
        }
      });
    }
    return _abAudio;
  }

  function abLoadChapter(idx, autoplay = false) {
    if (!_abBook || idx < 0 || idx >= _abBook.chapters.length) return;
    _abChapterIdx = idx;
    const ch = _abBook.chapters[idx];
    const audioEl = abGetAudio();

    // Virtual chapters share a file — only reload src when the file changes
    const fileId   = ch.realId || ch.id;
    const sameFile = audioEl.src && audioEl.src.includes(encodeURIComponent(fileId));
    if (!sameFile) {
      audioEl.src = audioSrc(fileId);
    }
    audioEl.playbackRate = _abSpeed;

    // Restore saved position (stored relative to ch.startTime)
    const chStart = ch.startTime ?? 0;
    const chEnd   = ch.endTime   ?? Infinity;
    const chDur   = isFinite(chEnd) ? chEnd - chStart : 0;
    const saved   = (_abProgress[_abBook.id] || {})[ch.id];
    // saved.position is relative; convert back to absolute audio time
    const absPos  = (saved && saved.position > 0 && saved.position < (saved.duration ?? chDur) - 2)
      ? chStart + saved.position
      : chStart;

    const seekAndPlay = () => {
      if (absPos > 0) audioEl.currentTime = absPos;
      if (autoplay) audioEl.play().catch(() => {});
    };

    if (!sameFile) {
      audioEl.addEventListener('loadedmetadata', seekAndPlay, { once: true });
    } else {
      seekAndPlay();
    }

    // Update player UI
    const trackEl = $('ab-player-track');
    if (trackEl) trackEl.textContent = ch.name;
    const subEl = $('ab-player-sub');
    if (subEl) subEl.textContent = `Chapter ${idx + 1} of ${_abBook.chapters.length}`;
    abUpdatePlayBtn();
    abUpdateProgressBar(0, 0);
    renderAbChapters();
    abWirePlayerControls();
  }

  let _abControlsWired = false;
  function abWirePlayerControls() {
    if (_abControlsWired) return;
    _abControlsWired = true;

    $('ab-play-btn').addEventListener('click', () => {
      if (!_abAudio) return;
      _abPlaying ? _abAudio.pause() : _abAudio.play().catch(() => {});
    });
    $('ab-skip-back-btn').addEventListener('click', () => {
      if (_abAudio) _abAudio.currentTime = Math.max(0, _abAudio.currentTime - 30);
    });
    $('ab-skip-fwd-btn').addEventListener('click', () => {
      if (_abAudio) _abAudio.currentTime = Math.min(_abAudio.duration || 0, _abAudio.currentTime + 30);
    });
    $('ab-prev-btn').addEventListener('click', () => {
      if (_abBook && _abChapterIdx > 0) abLoadChapter(_abChapterIdx - 1, _abPlaying);
    });
    $('ab-speed-btn').addEventListener('click', () => {
      const next = AB_SPEED_STEPS[(AB_SPEED_STEPS.indexOf(_abSpeed) + 1) % AB_SPEED_STEPS.length];
      _abSpeed = next;
      if (_abAudio) _abAudio.playbackRate = _abSpeed;
      const btn = $('ab-speed-btn');
      if (btn) btn.textContent = `${_abSpeed}×`;
    });

    // Seek on progress bar tap
    const progressBar = $('ab-player-progress');
    if (progressBar) {
      progressBar.addEventListener('click', (e) => {
        if (!_abAudio || !_abAudio.duration) return;
        const ch = _abBook?.chapters[_abChapterIdx];
        const chStart = ch?.startTime ?? 0;
        const chEnd   = ch?.endTime   ?? _abAudio.duration;
        const rect = progressBar.getBoundingClientRect();
        const pct  = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        _abAudio.currentTime = chStart + pct * (chEnd - chStart);
      });
    }
  }

  function abOnTimeUpdate() {
    if (!_abAudio || !_abBook) return;
    const pos = _abAudio.currentTime;
    const dur = _abAudio.duration || 0;
    const ch  = _abBook.chapters[_abChapterIdx];
    if (!ch) return;

    const chStart = ch.startTime ?? 0;
    const chEnd   = ch.endTime   ?? dur;
    const relPos  = Math.max(0, pos - chStart);
    const chDur   = Math.max(1, chEnd - chStart);

    // Virtual chapter boundary: advance to next part
    if (ch.endTime !== undefined && pos >= ch.endTime - 0.3 && _abPlaying) {
      if (_abChapterIdx < _abBook.chapters.length - 1) {
        // Save current part as complete before advancing, then flush so Continue
        // Listening sees accurate progress even after a page reload.
        saveAbProgress(_abBook.id, ch.id, chDur, chDur);
        flushAbProgressToFirestore(_abBook.id);
        abLoadChapter(_abChapterIdx + 1, true);
      }
      return;
    }

    abUpdateProgressBar(relPos, chDur);
    if (!dur || relPos < 2) return;
    if (Math.round(pos) % 5 === 0) {
      saveAbProgress(_abBook.id, ch.id, relPos, chDur);
    }
  }

  function abOnEnded() {
    if (!_abBook) return;
    const ch = _abBook.chapters[_abChapterIdx];
    if (ch && _abAudio) {
      const chStart = ch.startTime ?? 0;
      const chEnd   = ch.endTime   ?? _abAudio.duration;
      const chDur   = chEnd - chStart;
      saveAbProgress(_abBook.id, ch.id, chDur, chDur);
    }
    if (_abChapterIdx < _abBook.chapters.length - 1) {
      abLoadChapter(_abChapterIdx + 1, true);
    } else {
      _abPlaying = false;
      abUpdatePlayBtn();
      toast('🎉 Book complete!');
    }
  }

  function abUpdateProgressBar(pos, dur) {
    const pct = dur > 0 ? pos / dur : 0;
    const fill = $('ab-player-progress-fill');
    const dot  = $('ab-player-progress-dot');
    if (fill) fill.style.width = `${pct * 100}%`;
    if (dot)  dot.style.left   = `calc(${pct * 100}% - 5px)`;
    const elapsed = $('ab-player-elapsed');
    const remain  = $('ab-player-remain');
    if (elapsed) elapsed.textContent = fmtTime(pos);
    if (remain && dur > 0) remain.textContent = `−${fmtTime(dur - pos)}`;
  }

  function abUpdatePlayBtn() {
    const icon = $('ab-play-icon');
    if (!icon) return;
    icon.innerHTML = _abPlaying
      ? '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>'
      : '<polygon points="5 3 19 12 5 21 5 3"/>';
  }

  function abPause() {
    if (_abAudio && _abPlaying) _abAudio.pause();
    // Flush current position to Firestore immediately so hard refresh works
    flushAbProgressToFirestore();
  }

  function fmtTime(secs) {
    if (!secs || isNaN(secs)) return '0:00';
    const s = Math.floor(secs);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  // ── Book description: Google Books first, Gemini fallback ────────
  // ── Book info cache ───────────────────────────────────────────
  const _abBookInfoCache = {};  // in-memory; keyed by book title

  async function fetchBookInfo(title, hint = null) {
    if (!hint && _abBookInfoCache[title]) return _abBookInfoCache[title];

    // 1. Firestore cache (skip if hint provided — hint means we want a fresh fetch)
    if (!hint) {
      try {
        const snap = await window.fbDb.collection('audiobookInfo')
          .where('title', '==', title).limit(1).get();
        if (!snap.empty) {
          const d = snap.docs[0].data();
          const info = { author: d.author || null, description: d.description || null };
          _abBookInfoCache[title] = info;
          return info;
        }
      } catch { /* fall through */ }
    }

    // Strip subtitle for cleaner API searches; append hint if provided
    const shortTitle = title.split(/\s*[-:]\s+/)[0].trim();
    const searchQuery = hint ? `${shortTitle} ${hint}` : shortTitle;

    // 2. Google Books API
    let info = null;
    try {
      const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(searchQuery)}&maxResults=3`;
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        const item = (data.items || []).find(i => {
          const t = (i.volumeInfo?.title || '').toLowerCase();
          const q = shortTitle.toLowerCase();
          return t.includes(q.split(' ')[0]) || q.includes(t.split(' ')[0]);
        }) || data.items?.[0];
        if (item?.volumeInfo) {
          const candidate = {
            author: (item.volumeInfo.authors || []).join(', ') || null,
            description: item.volumeInfo.description || null,
          };
          if (candidate.author || candidate.description) info = candidate;
        }
      }
    } catch { /* fall through */ }

    // 3. Gemini fallback
    if (!info) {
      try {
        const key = (window.DRIFT_CONFIG || {}).geminiKey || '';
        if (key) {
          const hintLine = hint ? `\nAdditional context: ${hint}` : '';
          const prompt = `For the parenting audiobook titled "${shortTitle}":${hintLine}
1. The author's name (if you know it, otherwise write "Unknown")
2. A 2-3 sentence description of what the book is about

Respond in this exact JSON format with no extra text:
{"author": "Author Name", "description": "Description here."}`;
          const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`;
          const body = JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: 'application/json', temperature: 0.3, maxOutputTokens: 300 },
          });
          const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
          if (res.ok) {
            const data = await res.json();
            const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
            if (text) {
              const parsed = JSON.parse(text);
              info = {
                author: parsed.author && parsed.author !== 'Unknown' ? parsed.author : null,
                description: parsed.description || null,
              };
            }
          }
        }
      } catch { /* fall through */ }
    }

    if (!info) info = { author: null, description: null };

    // 4. Persist to Firestore so future loads skip the API calls (save even failures)
    try {
      await window.fbDb.collection('audiobookInfo').add({
        title,
        author: info.author || '',
        description: info.description || '',
        fetchedAt: Date.now(),
        failed: !info.author && !info.description,
      });
    } catch { /* non-fatal */ }

    _abBookInfoCache[title] = info;
    return info;
  }

  // Admin: fetch and cache info for every book in the library
  async function prefetchAllBookInfo(onProgress) {
    const lib = await loadAudiobookLibrary();
    const books = lib.books;
    let done = 0;
    for (const book of books) {
      // Delete any existing failed entry so we retry fresh
      try {
        const snap = await window.fbDb.collection('audiobookInfo')
          .where('title', '==', book.name).where('failed', '==', true).limit(1).get();
        if (!snap.empty) {
          await snap.docs[0].ref.delete();
          delete _abBookInfoCache[book.name];
        }
      } catch { /* non-fatal */ }
      await fetchBookInfo(book.name);
      done++;
      if (onProgress) onProgress(done, books.length);
    }
  }

})();
