// Drift configuration
// ===================
// If you fill these in here, the app uses them and skips the setup screen.
// If left blank, users are prompted on first load and values are saved to localStorage.
//
// SECURITY: Client-side API keys are safe to ship IF and only IF you restrict
// them in Google Cloud Console by HTTP referrer to your deploy domain.
// See README.md for instructions.

window.DRIFT_CONFIG = {
  apiKey: 'AIzaSyBaY-R1Lx5jNSIOHcHn29uHVL-9G1xbZaA',
  folderId: '1ob4gWC7yU4sWBnksReqVNRZk_N732BR-',
  geminiKey: 'AIzaSyA1Gkz6z6tU3tOwtAsyM2nEOUlsl--qs50',
  googleTTSKey: 'AIzaSyA1Gkz6z6tU3tOwtAsyM2nEOUlsl--qs50',
  // VIP TTS keys — add these after getting API keys
  sarvamKey: 'sk_pzohlf0p_D1vF8jYbldgB4D8lxOYSPZcy',   // Gujarati TTS (VIP) — primary key
  // Rotation pool for prerender-tts.js (used when a key hits quota)
  sarvamKeys: [
    'sk_pzohlf0p_D1vF8jYbldgB4D8lxOYSPZcy',
    'sk_ko9soonm_zyMNtnK60tfbGgDS3GPvHdwy',
    'sk_qbgir049_yUqynMonJPlN26iOT8tAYPbs',
    'sk_en0fwfub_y2MQQiL5KKPL4MlKwbz99yI4',
    'sk_g1gsxxoh_x12Razng1sLoJR9wNCmOUgYQ',
    'sk_7vmrmgfh_ExCFGuW3OOrsvrblHoEHuOAY',
    'sk_5oxybdw3_bcUcoaIL8qvNqoPWoysr4EMX',
    'sk_sx0pavjl_NnQUyABNUe9Y2f3nEVnBeF4A',
    'sk_51zv1ae5_mTcHIg0U9Hg46uSbyqejuGWZ',
    'sk_6yogdzni_E2o0MWsshG3lNjsXWrFSwNex',
    'sk_cz0rnqzq_LI2SW19DrscOJobZ7nADDVjo',
    'sk_mj980xq0_BlbCYrYalOBQsWG6ge8PVk3w',
    'sk_ff4z31pk_wesl7OV35iXC17aR8v2fRwLh',
    'sk_urcwa38z_L5hVUDzcOemDIgT5i79jaSPM',
    'sk_l5kycz3z_VVqBVBlvoaf32YBSeNRlGt1r',
  ],
  elevenLabsKey: '',                                      // English TTS (VIP) — add key here
  elevenLabsVoiceId: '21m00Tcm4TlvDq8ikWAM',             // Rachel (calm American English female)
};
