import { describe, it, expect } from 'vitest';
const { gujLocalAudioPath } = require('../utils.js');

// Learn Gujarati clips are bundled at www/guj-audio/ (trimmed + re-encoded);
// this mapping must exactly match scripts/build-guj-audio.js output names.
describe('gujLocalAudioPath — storage URL → bundled path', () => {
  const U = (p) => `https://firebasestorage.googleapis.com/v0/b/x.firebasestorage.app/o/${encodeURIComponent(p)}?alt=media&token=abc`;
  it('maps letters clips', () => {
    expect(gujLocalAudioPath(U('gujarati/vowels/audio/letters/a.mp3')))
      .toBe('guj-audio/vowels_letters_a.m4a');
  });
  it('maps words clips and keeps disambiguating segments', () => {
    expect(gujLocalAudioPath(U('gujarati/vowels/audio/words/anar.mp3')))
      .toBe('guj-audio/vowels_words_anar.m4a');
    expect(gujLocalAudioPath(U('gujarati/consonants/audio/letters/ka.mp3')))
      .toBe('guj-audio/consonants_letters_ka.m4a');
  });
  it('handles deeper paths and other extensions', () => {
    expect(gujLocalAudioPath(U('gujarati/verbs/audio/present/javu.m4a')))
      .toBe('guj-audio/verbs_present_javu.m4a');
  });
  it('returns null for non-gujarati or malformed urls', () => {
    expect(gujLocalAudioPath(U('prerendered-tts/x/p0.wav'))).toBeNull();
    expect(gujLocalAudioPath('not a url')).toBeNull();
    expect(gujLocalAudioPath(null)).toBeNull();
  });
});
