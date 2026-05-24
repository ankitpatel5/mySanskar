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
    currentTab: 'library',
    playCounts: {},
    libraryView: 'list',
    user: null,
    currentStory: null,
    currentCatId: null,
  };

  // ============== DOM ==============
  const $ = (id) => document.getElementById(id);
  const audio = $('audio');

  // ============== INIT ==============
  let _appBooted = false; // guard: only run full setup once

  async function proceedAsUser(user) {
    if (_appBooted) { hideLoading(); return; } // already running

    // Check if this user has been blocked by admin before doing anything else
    try {
      const blockedDoc = await window.fbDb.collection('blockedUsers').doc(user.uid).get();
      if (blockedDoc.exists) {
        hideLoading();
        await window.fbAuth.signOut();
        $('signin-screen').classList.remove('hidden');
        $('main-screen').classList.add('hidden');
        $('setup-screen').classList.add('hidden');
        const msg = $('blocked-msg');
        if (msg) msg.classList.remove('hidden');
        return;
      }
    } catch (e) {
      // If check fails (e.g. network), fail open and let them in
      console.warn('blocked-check failed — proceeding', e);
    }

    _appBooted = true;
    state.user = user;
    loadPersistedState();
    updateUserUI();
    syncUserProfile(user);
    setupBlockedListener(user);
    if (!API_KEY || !ROOT_FOLDER_ID) {
      hideLoading();
      showSetup();
      return;
    }
    showMain();
    updateAdminUI();
    setupEventListeners();
    loadVoices();
    setupAudio();
    bootstrapLibrary();
    loadFirestorePlaylists();
    checkShareParam();
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
    // Wire sign-in button (only once)
    const btn = $('google-signin-btn');
    if (btn && !btn.dataset.wired) {
      btn.dataset.wired = '1';
      btn.addEventListener('click', () => {
        btn.disabled = true;
        btn.textContent = 'Signing in…';
        window.fbAuth.signInWithPopup(window.fbGoogle)
          .catch((e) => {
            console.error('sign-in error:', e.code, e.message);
            btn.disabled = false;
            btn.textContent = 'Try again';
          });
      });
    }
  }

  function init() {
    showLoading('Loading…');

    // Fallback: if Firebase stalls (slow network, mobile background restore),
    // check currentUser directly after 7s rather than hanging forever.
    const stallTimer = setTimeout(() => {
      if ($('loading-overlay').classList.contains('hidden')) return;
      const u = window.fbAuth.currentUser;
      u ? proceedAsUser(u) : proceedAsGuest();
    }, 7000);

    window.fbAuth.onAuthStateChanged((user) => {
      clearTimeout(stallTimer);
      user ? proceedAsUser(user) : proceedAsGuest();
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
    if (!u) return;
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
    return name.endsWith('.mp3') || name.endsWith('.m4a') || name.endsWith('.wav')
        || name.endsWith('.ogg') || name.endsWith('.flac') || name.endsWith('.aac');
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
      showLoading('Building your library…');
    }
    try {
      const fresh = await buildLibrary();
      applyLibrary(fresh);
      try {
        localStorage.setItem(LS.library, JSON.stringify({ albums: fresh.albums, updatedAt: fresh.updatedAt }));
      } catch {}
      renderLibrary();
      $('library-sub').textContent = `${state.library.albums.length} albums · ${state.flatTracks.length} songs`;
      hideLoading();
    } catch (e) {
      hideLoading();
      console.error(e);
      if (!state.library) {
        toast('Could not load library. Check API key & folder ID.');
        $('library-sub').textContent = 'Library failed to load.';
      } else {
        toast('Refresh failed — using cached library.');
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
    audio.addEventListener('play', () => { state.playing = true; updatePlayIcon(); updateMediaSession(); refreshPlayingIndicators(); });
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
    audio.src = streamUrl(trackId);
    audio.play().catch((e) => { console.warn('play() rejected', e); });
    updateNowPlayingUI(t, true);
    refreshPlayingIndicators();
  }

  function playFromContext(trackId, context) {
    if (context === 'album' && state.activeAlbum) {
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
  function updateNowPlayingUI(track, resetTime = false) {
    if (!track) return;
    $('mini-title').textContent = track.name;
    $('mini-sub').textContent = track.albumName;
    $('sheet-title').textContent = track.name;
    $('sheet-sub').textContent = track.albumName;
    const initial = (track.albumName || '?').charAt(0).toUpperCase();
    applyArt($('mini-art'), track.albumName);
    applyArt($('sheet-art'), track.albumName);
    $('sheet-art').innerHTML = `<span class="folder-initial">${escapeHtml(initial)}</span>`;
    const [a] = paletteFor(track.albumName || '?');
    document.querySelector('.player-sheet')?.style.setProperty('--c-a', a);
    $('mini-player').classList.remove('hidden');
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
  function switchTab(tab) {
    state.currentTab = tab;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
    if (tab === 'library') switchView('view-library');
    else if (tab === 'playlists') { switchView('view-playlists'); renderPlaylists(); }
    else if (tab === 'queue') { switchView('view-queue'); renderQueue(); }
    else if (tab === 'stories') { stopTTS(); switchView('view-stories'); renderStoryCategories(); }
    $('content').scrollTo({ top: 0, behavior: 'instant' });
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

    // AI Generate placeholder
    const aiCard = document.createElement('div');
    aiCard.className = 'story-cat-card story-cat-ai';
    aiCard.setAttribute('aria-disabled', 'true');
    aiCard.innerHTML = `
      <div class="story-cat-icon">✨</div>
      <div class="story-cat-name">AI Stories</div>
      <div class="story-cat-count">Coming soon</div>
    `;
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
    if (!stories.length) {
      container.innerHTML = `<div class="empty-state"><h3>No stories found</h3><p>Try a different search.</p></div>`;
      return;
    }
    stories.forEach((story) => {
      const row = document.createElement('div');
      row.className = 'story-row';
      const isVideo = story.type === 'youtube';

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
          <div class="story-row-title">${story.title}</div>
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
    stopTTS();

    // Header
    $('story-reader-title').textContent = story.title;

    const isVideo = story.type === 'youtube';
    const img = $('story-reader-img');
    const ttsBar = $('story-tts-bar');
    const voiceSheet = $('tts-voice-sheet');

    if (isVideo) {
      // No photo header for video stories — YouTube player is the hero
      img.classList.add('hidden');
    } else if (story.photo) {
      img.src = story.photo;
      img.classList.remove('hidden');
      img.onerror = () => img.classList.add('hidden');
    } else {
      img.classList.add('hidden');
    }

    // Body
    const body = $('story-reader-body');
    body.innerHTML = '';

    if (isVideo) {
      // YouTube embed
      const wrap = document.createElement('div');
      wrap.className = 'story-youtube-wrap';
      wrap.innerHTML = `<iframe
        src="https://www.youtube.com/embed/${story.youtubeId}?rel=0&modestbranding=1"
        title="${story.title}"
        frameborder="0"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
        allowfullscreen></iframe>`;
      body.appendChild(wrap);
    }

    // Text paragraphs (may exist alongside video)
    if (story.paragraphs && story.paragraphs.length > 0) {
      story.paragraphs.forEach((p, i) => {
        const el = document.createElement('p');
        el.className = 'story-para';
        el.dataset.idx = i;
        el.textContent = p;
        body.appendChild(el);
      });
    }

    // Show/hide TTS bar — only useful when there are text paragraphs
    const hasParagraphs = story.paragraphs && story.paragraphs.length > 0;
    if (ttsBar) ttsBar.classList.toggle('hidden', !hasParagraphs);
    if (voiceSheet) voiceSheet.classList.add('hidden');

    updateTTSUI();
    switchView('view-story-reader');
    $('content').scrollTo({ top: 0, behavior: 'instant' });
  }

  // ============== TEXT-TO-SPEECH ==============

  const ttsState = { active: false, paused: false, idx: 0, voice: null };
  let _ttsVoices = [];

  // Load voices — they load async in most browsers
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
    if (!('speechSynthesis' in window)) { toast('Text-to-speech not supported on this device'); return; }
    if (!state.currentStory) return;
    ttsState.active = true;
    ttsState.paused = false;
    ttsState.idx = 0;
    speakParagraph(0);
    updateTTSUI();
  }

  function pauseTTS() {
    if (!ttsState.active || ttsState.paused) return;
    window.speechSynthesis.pause();
    ttsState.paused = true;
    updateTTSUI();
  }

  function resumeTTS() {
    if (!ttsState.active || !ttsState.paused) return;
    // Some browsers (Chrome Android) don't resume well — restart paragraph instead
    window.speechSynthesis.resume();
    // Fallback: if still paused after 200ms, restart the paragraph
    setTimeout(() => {
      if (ttsState.paused && ttsState.active) {
        ttsState.paused = false;
        window.speechSynthesis.cancel();
        speakParagraph(ttsState.idx);
      }
    }, 200);
    ttsState.paused = false;
    updateTTSUI();
  }

  function stopTTS() {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    ttsState.active = false;
    ttsState.paused = false;
    ttsState.idx = 0;
    document.querySelectorAll('.story-para.tts-active').forEach((el) => el.classList.remove('tts-active'));
    updateTTSUI();
  }

  function speakParagraph(idx) {
    const story = state.currentStory;
    if (!story || idx >= story.paragraphs.length) {
      stopTTS();
      return;
    }
    ttsState.idx = idx;

    // Highlight
    document.querySelectorAll('.story-para').forEach((el) => {
      el.classList.toggle('tts-active', parseInt(el.dataset.idx, 10) === idx);
    });

    // Scroll active paragraph into view
    const activeEl = document.querySelector(`.story-para[data-idx="${idx}"]`);
    if (activeEl) activeEl.scrollIntoView({ behavior: 'smooth', block: 'center' });

    // Progress
    const total = story.paragraphs.length;
    const bar = $('tts-progress-bar');
    if (bar) bar.style.width = total > 1 ? `${(idx / (total - 1)) * 100}%` : '100%';

    const utter = new SpeechSynthesisUtterance(story.paragraphs[idx]);
    utter.rate = 0.92;
    utter.lang = 'en-US';
    if (ttsState.voice) utter.voice = ttsState.voice;
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

    const isPlaying = ttsState.active && !ttsState.paused;
    const isPaused  = ttsState.active && ttsState.paused;

    playBtn.innerHTML = isPlaying
      ? `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`
      : `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><polygon points="6 4 20 12 6 20 6 4"/></svg>`;
    playBtn.setAttribute('aria-label', isPlaying ? 'Pause reading' : isPaused ? 'Resume reading' : 'Read aloud');
    playBtn.classList.toggle('reading', ttsState.active);

    if (label) {
      const voiceName = ttsState.voice
        ? ttsState.voice.name.replace(/^.*\.\w+-\w+\./i, '').replace(/_/g, ' ')
        : 'Read aloud';
      label.textContent = isPlaying ? 'Reading…' : isPaused ? 'Paused' : voiceName;
    }

    if (stopBtn) stopBtn.classList.toggle('hidden', !ttsState.active);

    if (!ttsState.active) {
      const bar = $('tts-progress-bar');
      if (bar) bar.style.width = '0%';
    }
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
  function toast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 2200);
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
  function setupEventListeners() {
    // Tabs
    document.querySelectorAll('.tab').forEach((t) => {
      t.addEventListener('click', () => switchTab(t.dataset.tab));
    });

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
      openConfirm(
        'Sign out?',
        'You can sign back in at any time. Your playlists are saved to the cloud.',
        () => { window.fbAuth.signOut().then(() => window.location.reload()); },
        { confirmLabel: 'Sign out', danger: false }
      );
    });
    $('user-menu-cancel').addEventListener('click', () => closeModal('user-menu'));
    document.querySelector('#user-menu .modal-backdrop').addEventListener('click', () => closeModal('user-menu'));

    // Admin dashboard
    const adminBtn = $('admin-btn');
    if (adminBtn) adminBtn.addEventListener('click', openAdminDashboard);
    const adminClose = $('admin-close');
    if (adminClose) adminClose.addEventListener('click', closeAdminDashboard);
    document.querySelectorAll('.admin-tab').forEach((btn) => {
      btn.addEventListener('click', () => loadAdminData(btn.dataset.atab));
    });

    // Settings modal
    $('settings-btn').addEventListener('click', () => showModal('settings-modal'));
    $('settings-cancel').addEventListener('click', () => closeModal('settings-modal'));
    document.querySelector('#settings-modal .modal-backdrop').addEventListener('click', () => closeModal('settings-modal'));
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
    document.querySelector('#import-modal .modal-backdrop').addEventListener('click', closeImport);

    // New playlist
    $('new-playlist-btn').addEventListener('click', () => {
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

    // ── Story Time ──────────────────────────────────────
    $('story-list-back').addEventListener('click', () => {
      stopTTS();
      switchTab('stories');
    });
    $('story-reader-back').addEventListener('click', () => {
      stopTTS();
      switchView('view-story-list');
      $('content').scrollTo({ top: 0, behavior: 'instant' });
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
    $('tts-voice-btn').addEventListener('click', () => {
      const sheet = $('tts-voice-sheet');
      if (sheet && !sheet.classList.contains('hidden')) closeVoicePicker();
      else openVoicePicker();
    });
    $('tts-voice-close').addEventListener('click', closeVoicePicker);
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

    // Track menu
    document.querySelectorAll('#track-menu .modal-item').forEach((btn) => {
      btn.addEventListener('click', () => {
        const action = btn.dataset.action;
        if (action === 'cancel') { closeModal('track-menu'); return; }
        handleTrackMenuAction(action);
      });
    });
    document.querySelector('#track-menu .modal-backdrop').addEventListener('click', () => closeModal('track-menu'));

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
    document.querySelector('#picker-modal .modal-backdrop').addEventListener('click', () => closeModal('picker-modal'));

    // Modal backdrops
    document.querySelector('#confirm-modal .modal-backdrop').addEventListener('click', () => closeModal('confirm-modal'));
    document.querySelector('#prompt-modal .modal-backdrop').addEventListener('click', () => closeModal('prompt-modal'));

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
  }

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

  // ============== GO ==============
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
