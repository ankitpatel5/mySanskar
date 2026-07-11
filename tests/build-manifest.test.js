import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Every local <script src> in index.html must be shipped by build-www.sh —
// a file missing from its FILES whitelist 404s ONLY on native (web serves the
// repo root), which silently broke utils.js → "No music found" on iOS.
describe('build-www.sh ships every script index.html loads', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const indexHtml = readFileSync(join(root, 'index.html'), 'utf8');
  const buildSh = readFileSync(join(root, 'scripts/build-www.sh'), 'utf8');

  const srcs = [...indexHtml.matchAll(/src="([A-Za-z0-9._-]+\.js)(?:\?[^"]*)?"/g)]
    .map((m) => m[1])
    .filter((f) => !f.startsWith('http'));

  // config.js (gitignored) and app-build.js (generated) are copied/created by
  // dedicated steps in build-www.sh rather than the FILES whitelist.
  const SPECIAL = new Set(['config.js', 'app-build.js']);

  it('found the script list (sanity)', () => {
    expect(srcs.length).toBeGreaterThanOrEqual(10);
  });

  for (const src of [...new Set(srcs)]) {
    it(`${src} is shipped`, () => {
      const covered = SPECIAL.has(src) || buildSh.includes(`  ${src}`) || buildSh.includes(`\n  ${src}\n`);
      expect(covered, `${src} is loaded by index.html but not in build-www.sh FILES`).toBe(true);
    });
  }
});
