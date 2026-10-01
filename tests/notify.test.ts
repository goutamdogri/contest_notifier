import { describe, expect, it } from 'vitest';
import { outageNotices, formatOutageReason } from '../src/notify.js';
import type { Platform } from '../src/models.js';

describe('formatOutageReason', () => {
  it('trims whitespace so a notification body stays on one line', () => {
    expect(formatOutageReason('GET  https://x/  failed\n\n  after 4 attempts')).not.toContain('\n');
  });

  it('promotes the underlying cause and drops the retry boilerplate', () => {
    const out = formatOutageReason(
      'GET https://leetcode.com/graphql failed after 4 attempt(s): HTTP 429 Too Many Requests',
    );
    expect(out).toContain('HTTP 429');
    expect(out).toContain('https://leetcode.com/graphql');
    expect(out).toContain('after 4 attempts');
    expect(out).not.toContain('attempt(s)');
  });

  it('uses a singular attempt when there was only one', () => {
    const out = formatOutageReason('GET https://x/ failed after 1 attempt(s): HTTP 404 Not Found');
    expect(out).toContain('after 1 attempt');
    expect(out).not.toContain('after 1 attempts');
  });

  it('truncates a very long error instead of overflowing the notification', () => {
    const long = 'x'.repeat(1000);
    const out = formatOutageReason(long, 120);
    expect(out.length).toBeLessThanOrEqual(120);
    expect(out.endsWith('…')).toBe(true);
  });

  it('returns an empty-ish string rather than throwing on an empty error', () => {
    expect(() => formatOutageReason('')).not.toThrow();
  });
});

describe('outageNotices', () => {
  const cf: { platform: Platform; error: string } = {
    platform: 'codeforces',
    error: 'HTTP 503',
  };
  const ac: { platform: Platform; error: string } = {
    platform: 'atcoder',
    error: 'HTTP 403',
  };

  it('raises a notice for a failing provider', () => {
    const notices = outageNotices([cf], {});
    expect(notices).toHaveLength(1);
    expect(notices[0]?.title).toContain('Codeforces');
    expect(notices[0]?.body).toContain('HTTP 503');
  });

  it('includes the reason in the body, not just the provider name', () => {
    const [notice] = outageNotices([cf], {});
    expect(notice?.body).toContain('503');
  });

  it('silences only the provider that is suppressed', () => {
    const notices = outageNotices([cf, ac], { codeforces: true });
    expect(notices).toHaveLength(1);
    expect(notices[0]?.title).toContain('AtCoder');
  });

  it('silences a provider when suppression is explicitly true', () => {
    expect(outageNotices([ac], { atcoder: true })).toHaveLength(0);
  });

  it('still alerts when suppression is explicitly false', () => {
    expect(outageNotices([ac], { atcoder: false })).toHaveLength(1);
  });

  it('returns nothing when there are no failures', () => {
    expect(outageNotices([], {})).toHaveLength(0);
    expect(outageNotices([], { codeforces: true })).toHaveLength(0);
  });

  it('handles undefined suppression config', () => {
    expect(outageNotices([cf], undefined)).toHaveLength(1);
  });

  it('emits one notice per failing provider', () => {
    const notices = outageNotices(
      [
        { platform: 'codeforces', error: 'a' },
        { platform: 'atcoder', error: 'b' },
        { platform: 'codechef', error: 'c' },
      ],
      {},
    );
    expect(notices).toHaveLength(3);
  });

  it('uses the friendly platform label, not the internal key', () => {
    expect(outageNotices([{ platform: 'leetcode', error: 'x' }], {})[0]?.title).toContain(
      'LeetCode',
    );
  });
});