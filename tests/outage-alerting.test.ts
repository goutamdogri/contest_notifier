import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DateTime } from 'luxon';
import { loadConfig } from '../src/config.js';
import type { Contest, Platform } from '../src/models.js';

/**
 * End-to-end check that a provider outage actually reaches the desktop, with the
 * reason attached, and that the per-provider mute flag really silences it.
 *
 * fetchAll is stubbed at the module boundary (it binds its fetchers in a const
 * record at import time, so spying on the fetchers themselves would not take
 * effect). Google is never contacted: every case here is a dry run.
 */

interface FailureSpec {
  platform: Platform;
  error: string;
}

const state = vi.hoisted(() => ({
  failures: [] as Array<{ platform: string; error: string }>,
  contests: [] as Contest[],
  spawned: [] as Array<{ title: string; body: string }>,
  spawnAvailable: true,
}));

vi.mock('../src/sources/index.js', () => ({
  fetchAll: vi.fn(async () => ({
    contests: state.contests,
    failures: state.failures,
  })),
  filterContests: (contests: Contest[]) => contests,
}));

vi.mock('../src/notify.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/notify.js')>();
  return {
    ...actual,
    notifyDesktop: vi.fn((title: string, body: string) => {
      state.spawned.push({ title, body });
    }),
  };
});

const { run } = await import('../src/run.js');

let stateDir: string;

function configWith(suppress?: Partial<Record<Platform, boolean>>) {
  const base = loadConfig();
  return {
    ...base,
    sources: Object.fromEntries(
      Object.entries(base.sources).map(([k, v]) => [
        k,
        { ...v, enabled: true, pollIntervalMinutes: 1 },
      ]),
    ),
    notifications: { desktop: true, suppressOutageNotifications: suppress ?? {} },
    paths: { ...base.paths, dbFile: join(stateDir, 'test.db') },
  };
}

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'outage-'));
  state.failures = [];
  state.contests = [];
  state.spawned = [];
});

describe('provider outage raises a desktop notification', () => {
  it('notifies with the provider name and the reason', async () => {
    state.failures = [{ platform: 'codeforces', error: 'HTTP 503 Service Unavailable' }];

    const summary = await run(configWith(), { force: true, dryRun: true, interactive: false });

    expect(summary.failures).toHaveLength(1);
    expect(state.spawned).toHaveLength(1);
    expect(state.spawned[0]?.title).toContain('Codeforces');
    expect(state.spawned[0]?.body).toContain('HTTP 503');
  });

  it('notifies once per failing provider', async () => {
    state.failures = [
      { platform: 'codeforces', error: 'HTTP 503' },
      { platform: 'atcoder', error: 'HTTP 403' },
      { platform: 'leetcode', error: 'HTTP 429' },
    ];

    await run(configWith(), { force: true, dryRun: true, interactive: false });

    expect(state.spawned).toHaveLength(3);
    for (const platform of ['Codeforces', 'AtCoder', 'LeetCode']) {
      expect(state.spawned.some((n) => n.title.includes(platform))).toBe(true);
    }
  });

  it('does not notify when every provider is healthy', async () => {
    state.contests = [
      {
        platform: 'codeforces',
        platformId: '1',
        key: 'codeforces:1',
        name: 'Test Round',
        start: DateTime.fromISO('2026-10-02T12:00:00Z', { zone: 'utc' }),
        end: DateTime.fromISO('2026-10-02T14:00:00Z', { zone: 'utc' }),
        url: 'https://example.invalid',
        inProgress: false,
        warnings: [],
      },
    ];

    await run(configWith(), { force: true, dryRun: true, interactive: false });

    expect(state.spawned).toHaveLength(0);
  });

  it('stays silent when that specific provider is muted', async () => {
    state.failures = [{ platform: 'leetcode', error: 'HTTP 429' }];

    await run(configWith({ leetcode: true }), { force: true, dryRun: true, interactive: false });

    expect(state.spawned).toHaveLength(0);
  });

  it('mutes only the named provider and still alerts on the others', async () => {
    state.failures = [
      { platform: 'leetcode', error: 'HTTP 429' },
      { platform: 'codechef', error: 'HTTP 500' },
    ];

    await run(configWith({ leetcode: true }), { force: true, dryRun: true, interactive: false });

    expect(state.spawned).toHaveLength(1);
    expect(state.spawned[0]?.title).toContain('CodeChef');
    expect(state.spawned.some((n) => n.title.includes('LeetCode'))).toBe(false);
  });

  it('still records the failure in the summary when muted', async () => {
    state.failures = [{ platform: 'leetcode', error: 'HTTP 429' }];

    const summary = await run(configWith({ leetcode: true }), {
      force: true,
      dryRun: true,
      interactive: false,
    });

    expect(summary.failures).toEqual([
      { scope: 'source:leetcode', error: 'HTTP 429' },
    ]);
  });

  it('surfaces the retry cause rather than the retry boilerplate', async () => {
    state.failures = [
      {
        platform: 'leetcode',
        error:
          'POST https://leetcode.com/graphql failed after 3 attempt(s): HTTP 429 Too Many Requests',
      },
    ];

    await run(configWith(), { force: true, dryRun: true, interactive: false });

    expect(state.spawned[0]?.body).toContain('HTTP 429');
    expect(state.spawned[0]?.body).not.toContain('attempt(s)');
  });
});