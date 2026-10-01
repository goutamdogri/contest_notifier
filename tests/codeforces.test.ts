import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { parseCodeforcesPayload } from '../src/sources/codeforces.js';

const NOW = DateTime.fromISO('2026-10-01T09:26:00Z', { zone: 'utc' });

function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 2275,
    name: 'Codeforces Round (Div. 3)',
    type: 'ICPC',
    phase: 'BEFORE',
    frozen: false,
    durationSeconds: 9000,
    startTimeSeconds: 1_800_000_000,
    relativeTimeSeconds: -100000,
    ...overrides,
  };
}

function envelope(result: unknown[]): unknown {
  return { status: 'OK', result };
}

describe('parseCodeforcesPayload', () => {
  it('computes the end time from durationSeconds', () => {
    // There is no endTimeSeconds in the API, so it must be derived.
    const [contest] = parseCodeforcesPayload(
      envelope([entry({ startTimeSeconds: 1_800_000_000, durationSeconds: 9000 })]),
      NOW,
    );
    expect(contest?.end.toMillis() - contest!.start.toMillis()).toBe(9_000_000);
  });

  it('builds the key and URL from the numeric contest id', () => {
    const [contest] = parseCodeforcesPayload(envelope([entry({ id: 2275 })]), NOW);
    expect(contest?.key).toBe('codeforces:2275');
    expect(contest?.url).toBe('https://codeforces.com/contest/2275');
  });

  it('treats epoch seconds as UTC', () => {
    const [contest] = parseCodeforcesPayload(
      envelope([entry({ startTimeSeconds: 1_800_000_000 })]),
      NOW,
    );
    expect(contest?.start.toUTC().toISO()).toBe(new Date(1_800_000_000 * 1000).toISOString());
  });

  it('drops FINISHED contests', () => {
    // contest.list returns the full 2000+ contest history in one response.
    const contests = parseCodeforcesPayload(
      envelope([entry({ id: 1, phase: 'FINISHED' }), entry({ id: 2275, phase: 'BEFORE' })]),
      NOW,
    );
    expect(contests).toHaveLength(1);
    expect(contests[0]?.platformId).toBe('2275');
  });

  it('keeps non-BEFORE phases and marks them in progress', () => {
    for (const phase of ['CODING', 'PENDING_SYSTEM_TEST', 'SYSTEM_TEST']) {
      const [contest] = parseCodeforcesPayload(
        envelope([entry({ phase, startTimeSeconds: Math.floor(NOW.toMillis() / 1000) - 600 })]),
        NOW,
      );
      expect(contest?.inProgress).toBe(true);
    }
  });

  it('marks BEFORE contests as not in progress', () => {
    const [contest] = parseCodeforcesPayload(envelope([entry({ phase: 'BEFORE' })]), NOW);
    expect(contest?.inProgress).toBe(false);
  });

  it('skips entries with no usable start time', () => {
    const contests = parseCodeforcesPayload(
      envelope([entry({ id: 1, startTimeSeconds: 0 }), entry({ id: 2, startTimeSeconds: -5 })]),
      NOW,
    );
    expect(contests).toEqual([]);
  });

  it('drops contests that already ended even if phase says otherwise', () => {
    const contests = parseCodeforcesPayload(
      envelope([
        entry({
          id: 99,
          startTimeSeconds: Math.floor(NOW.toMillis() / 1000) - 86_400,
          durationSeconds: 60,
          phase: 'BEFORE',
        }),
      ]),
      NOW,
    );
    expect(contests).toEqual([]);
  });

  it('throws a clear error on the documented rate-limit response', () => {
    expect(() =>
      parseCodeforcesPayload({ status: 'FAILED', comment: 'Call limit exceeded' }, NOW),
    ).toThrow(/Call limit exceeded/);
  });

  it('throws when the payload shape changes', () => {
    expect(() => parseCodeforcesPayload({ totally: 'different' }, NOW)).toThrow(
      /Unexpected Codeforces payload/,
    );
  });

  it('tolerates an OK response with no result array', () => {
    expect(parseCodeforcesPayload({ status: 'OK' }, NOW)).toEqual([]);
  });

  it('skips malformed rows rather than failing the whole parse', () => {
    const contests = parseCodeforcesPayload(
      envelope([entry({ id: 'not-a-number' }), entry({ id: 42 })]),
      NOW,
    );
    expect(contests).toHaveLength(1);
    expect(contests[0]?.platformId).toBe('42');
  });
});
