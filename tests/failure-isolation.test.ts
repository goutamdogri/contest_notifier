import { describe, expect, it, vi } from 'vitest';
import { DateTime } from 'luxon';
import { loadConfig } from '../src/config.js';
import type { Contest } from '../src/models.js';

/**
 * Sources are stubbed at the module boundary rather than by spying on the exported
 * functions: fetchAll captures the fetchers in a const record at import time, so
 * vi.spyOn on the namespace object would not affect the already-bound references.
 */
const failing = vi.hoisted(() => ({
  codeforces: new Error('ECONNREFUSED codeforces'),
  atcoder: new Error('HTTP 403 atcoder'),
  codechef: new Error('HTTP 429 codechef'),
}));

vi.mock('../src/sources/codeforces.js', () => ({
  fetchCodeforces: vi.fn(async () => {
    throw failing.codeforces;
  }),
  parseCodeforcesPayload: vi.fn(),
}));
vi.mock('../src/sources/atcoder.js', () => ({
  fetchAtCoder: vi.fn(async () => {
    throw failing.atcoder;
  }),
  parseAtCoderHtml: vi.fn(),
}));
vi.mock('../src/sources/codechef.js', () => ({
  fetchCodeChef: vi.fn(async () => {
    throw failing.codechef;
  }),
  parseCodeChefPayload: vi.fn(),
}));
vi.mock('../src/sources/leetcode.js', () => ({
  fetchLeetCode: vi.fn(async () => {
    return [] as Contest[];
  }),
  parseLeetCodePayload: vi.fn(),
}));

const { fetchAll } = await import('../src/sources/index.js');

const NOW = DateTime.fromISO('2026-10-01T00:00:00Z', { zone: 'utc' });
const config = loadConfig();
const ALL = ['codeforces', 'atcoder', 'codechef'] as const;

describe('source failure isolation', () => {
  it('does not throw when a source fails', async () => {
    await expect(fetchAll(config, NOW, [...ALL])).resolves.toBeDefined();
  });

  it('records a failure per broken source, preserving the message', async () => {
    const { failures } = await fetchAll(config, NOW, [...ALL]);
    expect(failures).toHaveLength(3);
    expect(failures.map((f) => f.platform).sort()).toEqual(['atcoder', 'codechef', 'codeforces']);
    expect(failures.find((f) => f.platform === 'codeforces')?.error).toContain('ECONNREFUSED');
  });

  it('still returns contests from the sources that did not fail', async () => {
    const cf = await import('../src/sources/codeforces.js');
    vi.mocked(cf.fetchCodeforces).mockResolvedValueOnce([
      {
        platform: 'codeforces', platformId: '1', key: 'codeforces:1', name: 'Ok',
        start: NOW.plus({ days: 1 }), end: NOW.plus({ days: 1, hours: 2 }),
        url: 'u', inProgress: false, warnings: [],
      } satisfies Contest,
    ]);

    const { contests, failures } = await fetchAll(config, NOW, [...ALL]);
    expect(failures).toHaveLength(2);
    expect(contests.map((c) => c.key)).toEqual(['codeforces:1']);
  });

  it('returns an empty list and three failures when nothing works', async () => {
    const { contests, failures } = await fetchAll(config, NOW, [...ALL]);
    expect(contests).toHaveLength(0);
    expect(failures).toHaveLength(3);
  });

  it('does not count a source that was not requested', async () => {
    const { failures } = await fetchAll(config, NOW, ['codeforces']);
    expect(failures.map((f) => f.platform)).toEqual(['codeforces']);
  });
});