import { describe, it, expect } from 'vitest';
const { parseAlbumFolderName } = require('../utils.js');

// The "[NS]" Drive-folder prefix routes an album to the Fun & Rhymes section
// and must be stripped so it never renders (grid, search, lock screen).
describe('parseAlbumFolderName — [NS] section contract', () => {
  it('routes [NS] folders to fun and strips the marker', () => {
    expect(parseAlbumFolderName('[NS] Nursery Rhymes'))
      .toEqual({ name: 'Nursery Rhymes', section: 'fun' });
  });
  it('is case- and whitespace-tolerant', () => {
    expect(parseAlbumFolderName('[ns]Lullabies').section).toBe('fun');
    expect(parseAlbumFolderName('  [ NS ]  Sing-alongs')).toEqual({ name: 'Sing-alongs', section: 'fun' });
  });
  it('leaves non-NS folders in satsang with the name untouched', () => {
    expect(parseAlbumFolderName('Kirtans')).toEqual({ name: 'Kirtans', section: 'satsang' });
  });
  it('does NOT treat other bracket tags as NS', () => {
    expect(parseAlbumFolderName('[Eng] Nursery Rhymes'))
      .toEqual({ name: '[Eng] Nursery Rhymes', section: 'satsang' });
  });
  it('keeps secondary tags after stripping NS', () => {
    expect(parseAlbumFolderName('[NS] [Eng] Rhymes'))
      .toEqual({ name: '[Eng] Rhymes', section: 'fun' });
  });
  it('only matches NS as a PREFIX', () => {
    expect(parseAlbumFolderName('Songs [NS]').section).toBe('satsang');
  });
  it('tolerates empty/nullish input', () => {
    expect(parseAlbumFolderName('')).toEqual({ name: '', section: 'satsang' });
    expect(parseAlbumFolderName(null)).toEqual({ name: '', section: 'satsang' });
  });
});
