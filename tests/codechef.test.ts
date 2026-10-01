import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { parseCodeChefPayload } from '../src/sources/codechef.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import type { Config } from '../src/config.js';

const NOW = DateTime.fromISO('2026-10-01T09:26:00Z', { zone: 'utc' });

function config(maxEventHours = 12): Config {
  return {
    ...DEFAULT_CONFIG,
    filters: { ...DEFAULT_CONFIG.filters, maxEventHours },
    paths: {
      configDir: '/tmp',
      stateDir: '/tmp',
      tokenFile: '/tmp/t',
      credentialsFile: '/tmp/c',
      dbFile: '/tmp/d',
      logFile: '/tmp/l',
    },
  };
}

/** Shapes recorded from the live /api/list/contests/future endpoint. */
function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contest_id: '75969',
    contest_code: 'DSAMONDAY023',
    contest_name: 'Monday Munch - DSA Challenge 023 (Rated)',
    contest_start_date: '05 Oct 2026  19:00:00',
    contest_end_date: '05 Oct 2026  22:00:00',
    contest_start_date_iso: '2026-10-05T19:00:00+05:30',
    contest_end_date_iso: '2026-10-05T22:00:00+05:30',
    contest_duration: '180',
    distinct_users: 0,
    ...overrides,
  };
}

function envelope(contests: unknown[]): unknown {
  return { status: 'success', message: 'future contests list', contests };
}

describe('parseCodeChefPayload', () => {
  it('parses a normal single-session contest', () => {
    const [contest] = parseCodeChefPayload(envelope([entry()]), config(), NOW);
    expect(contest?.key).toBe('codechef:DSAMONDAY023');
    expect(contest?.name).toBe('Monday Munch - DSA Challenge 023 (Rated)');
    expect(contest?.start.toUTC().toISO()).toBe('2026-10-05T13:30:00.000Z');
    expect(contest?.end.toUTC().toISO()).toBe('2026-10-05T16:30:00.000Z');
    expect(contest?.url).toBe('https://www.codechef.com/DSAMONDAY023');
    expect(contest?.warnings).toEqual([]);
  });

  it('reads the ISO fields, not the double-spaced locale strings', () => {
    // contest_start_date is "05 Oct 2026  19:00:00" with two spaces and no offset.
    const [contest] = parseCodeChefPayload(envelope([entry()]), config(), NOW);
    expect(contest?.start.isValid).toBe(true);
    expect(contest?.start.toFormat('yyyy-LL-dd HH:mm')).toBe('2026-10-05 19:00');
  });

  it('falls back to the declared session length for multi-session containers', () => {
    // PLACEPREP10: declared 120 min but the API end is ~50h after the start.
    const [contest] = parseCodeChefPayload(
      envelope([
        entry({
          contest_id: '75646',
          contest_code: 'PLACEPREP10',
          contest_name: 'Placement Prep Weekends - 10',
          contest_start_date_iso: '2026-10-03T00:00:32+05:30',
          contest_end_date_iso: '2026-10-05T01:59:00+05:30',
          contest_duration: '120',
        }),
      ]),
      config(),
      NOW,
    );

    expect(contest?.end.diff(contest!.start, 'minutes').minutes).toBe(120);
    expect(contest?.warnings.join(' ')).toMatch(/multi-session container/);
  });

  it('keeps the reported end when the span is plausible', () => {
    const [contest] = parseCodeChefPayload(envelope([entry()]), config(12), NOW);
    expect(contest?.end.diff(contest!.start, 'minutes').minutes).toBe(180);
    expect(contest?.warnings).toEqual([]);
  });

  it('handles numeric contest_id and duration types', () => {
    const [contest] = parseCodeChefPayload(
      envelope([entry({ contest_id: 12345, contest_duration: 90 })]),
      config(),
      NOW,
    );
    expect(contest?.platformId).toBe('DSAMONDAY023');
  });

  it('trims whitespace in contest names', () => {
    const [contest] = parseCodeChefPayload(
      envelope([entry({ contest_name: 'July Cook Off  ' })]),
      config(),
      NOW,
    );
    expect(contest?.name).toBe('July Cook Off');
  });

  it('skips rows that fail validation instead of aborting the whole run', () => {
    const contests = parseCodeChefPayload(
      envelope([
        entry({ contest_code: '' }),
        entry({ contest_start_date_iso: 'not-a-date' }),
        { nonsense: true },
        entry({ contest_code: 'GOOD1' }),
      ]),
      config(),
      NOW,
    );
    expect(contests).toHaveLength(1);
    expect(contests[0]?.platformId).toBe('GOOD1');
  });

  it('skips contests that already ended', () => {
    const contests = parseCodeChefPayload(
      envelope([entry({ contest_start_date_iso: '2020-01-01T00:00:00+05:30', contest_end_date_iso: '2020-01-01T03:00:00+05:30' })]),
      config(),
      NOW,
    );
    expect(contests).toEqual([]);
  });

  it('flags a contest that is already running', () => {
    // NOW is 2026-10-01 14:56 IST, so this 10:00-20:00 IST window straddles it.
    const contests = parseCodeChefPayload(
      envelope([entry({ contest_start_date_iso: '2026-10-01T10:00:00+05:30', contest_end_date_iso: '2026-10-01T20:00:00+05:30' })]),
      config(),
      NOW,
    );
    expect(contests[0]?.inProgress).toBe(true);
  });

  it('does not flag a future contest as in progress', () => {
    const [contest] = parseCodeChefPayload(envelope([entry()]), config(), NOW);
    expect(contest?.inProgress).toBe(false);
  });

  it('throws a clear error on a non-success envelope', () => {
    expect(() => parseCodeChefPayload({ status: 'error', message: 'nope', contests: [] }, config(), NOW)).toThrow(
      /status=error/,
    );
  });

  it('throws when the payload shape changes entirely', () => {
    expect(() => parseCodeChefPayload({ totally: 'different' }, config(), NOW)).toThrow(
      /Unexpected CodeChef payload/,
    );
  });

  it('surfaces the broken /upcoming endpoint if it is ever pointed at by mistake', () => {
    // The upstream /upcoming route returns 2009 contests with status "success".
    // Those are all in the past, so the parse yields nothing rather than junk.
    const stale = envelope([
      entry({
        contest_code: 'MARCH09',
        contest_name: 'March 2009 (Contest I)',
        contest_start_date_iso: '2009-02-28T22:00:00+05:30',
        contest_end_date_iso: '2009-03-15T00:00:00+05:30',
      }),
    ]);
    expect(parseCodeChefPayload(stale, config(), NOW)).toEqual([]);
  });
});
