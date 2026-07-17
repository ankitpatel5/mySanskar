// First-run notification soft-ask — wiring guards.
// The flow is DOM+native-plugin heavy, so these are source-contract checks:
// they catch the silent failure modes (call site dropped, one-shot flag
// renamed on one side, sheet markup missing) that unit tests can't see.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const appSrc = readFileSync(join(root, 'app.js'), 'utf8');
const htmlSrc = readFileSync(join(root, 'index.html'), 'utf8');

describe('notification soft-ask wiring', () => {
  it('sheet markup exists with both actions and the approved copy', () => {
    expect(htmlSrc).toContain('id="notif-ask-modal"');
    expect(htmlSrc).toContain('id="notif-ask-yes"');
    expect(htmlSrc).toContain('id="notif-ask-no"');
    expect(htmlSrc).toContain('Ekadashi reminders and other special announcements');
  });

  it('is called from both landings: boot path and onboarding completion', () => {
    const calls = appSrc.match(/setTimeout\(maybeShowNotifAsk/g) || [];
    expect(calls.length).toBe(2);
  });

  it('marks the once-per-install flag before showing (no re-ask loops)', () => {
    const fn = appSrc.slice(appSrc.indexOf('function maybeShowNotifAsk'));
    const body = fn.slice(0, fn.indexOf('function initEkadashiReminderSettings'));
    expect(body).toContain("localStorage.getItem('drift.notifAsked')");
    expect(body).toContain("localStorage.setItem('drift.notifAsked', '1')");
    // mark() must run before the sheet is revealed
    expect(body.indexOf('mark();')).toBeLessThan(body.indexOf("classList.remove('hidden')"));
  });

  it('never burns the one-shot iOS prompt without an explicit Turn on tap', () => {
    const fn = appSrc.slice(appSrc.indexOf('function maybeShowNotifAsk'));
    const body = fn.slice(0, fn.indexOf('function initEkadashiReminderSettings'));
    // requestPermissions may only appear inside the notif-ask-yes handler
    const yesIdx = body.indexOf("$('notif-ask-yes')");
    const reqIdx = body.indexOf('requestPermissions');
    expect(yesIdx).toBeGreaterThan(-1);
    expect(reqIdx).toBeGreaterThan(yesIdx);
  });

  it('enables both features on grant, push gated to signed-in non-guests', () => {
    const fn = appSrc.slice(appSrc.indexOf('function maybeShowNotifAsk'));
    const body = fn.slice(0, fn.indexOf('function initEkadashiReminderSettings'));
    expect(body).toContain('syncEkadashiReminders()');
    expect(body).toContain('savePushToken(token, true)');
    expect(body).toContain('!isGuestMode()');
  });

  it('device-level ask flag is NOT wiped on sign-out (permission is per-device)', () => {
    const perUser = appSrc.slice(appSrc.indexOf('PER_USER_LS_KEYS = ['), appSrc.indexOf('PER_USER_LS_KEYS = [') + 800);
    expect(perUser).not.toContain('drift.notifAsked');
  });
});
