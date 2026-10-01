import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { parseLeetCodePayload } from '../src/sources/leetcode.js';

const NOW = DateTime.fromISO('2026-10-01T00:00:00Z', { zone: 'utc' });

/** Weekly Contest 523: Sun 11 Oct 2026 02:30 UTC, 90 minutes. */
const WEEKLY = {
  title: 'Weekly Contest 523',
  titleSlug: 'weekly-contest-523',
  startTime: 1791685800,
  duration: 5400,
};

/** Biweekly Contest 193: Sat 10 Oct 2026 14:30 UTC, 90 minutes. */
const BIWEEKLY = {
  title: 'Biweekly Contest 193',
  titleSlug: 'biweekly-contest-193',
  startTime: 1791642600,
  duration: 5400,
};

function payload(rows: unknown[]) {
  return { data: { allContests: rows } };
}

describe('parseLeetCodePayload', () => {
  it('parses a weekly contest', () => {
    const [contest] = parseLeetCodePayload(payload([WEEKLY]), NOW);
    expect(contest?.platform).toBe('leetcode');
    expect(contest?.platformId).toBe('weekly-contest-523');
    expect(contest?.key).toBe('leetcode:weekly-contest-523');
    expect(contest?.url).toBe('https://leetcode.com/contest/weekly-contest-523/');
  });

  it('parses a biweekly contest, which allContests returns but upcomingContests omits', () => {
    const contests = parseLeetCodePayload(payload([BIWEEKLY]), NOW);
    expect(contests).toHaveLength(1);
    expect(contests[0]?.platformId).toBe('biweekly-contest-193');
  });

  it('keeps both series in one response', () => {
    expect(parseLeetCodePayload(payload([WEEKLY, BIWEEKLY]), NOW)).toHaveLength(2);
  });

  it('converts the epoch seconds to UTC correctly', () => {
    const [contest] = parseLeetCodePayload(payload([WEEKLY]), NOW);
    expect(contest?.start.toISO()).toBe('2026-10-11T02:30:00.000Z');
    // 08:00 IST, which is LeetCode's published weekly slot.
    expect(contest?.start.setZone('Asia/Kolkata').toFormat('ccc HH:mm')).toBe('Sun 08:00');
  });

  it('derives the end from the 5400 second duration', () => {
    const [contest] = parseLeetCodePayload(payload([WEEKLY]), NOW);
    expect(contest?.end.toISO()).toBe('2026-10-11T04:00:00.000Z');
    expect(contest?.end.diff(contest!.start, 'minutes').minutes).toBe(90);
  });

  it('shortens the summary but keeps the series word', () => {
    const [contest] = parseLeetCodePayload(payload([WEEKLY]), NOW);
    expect(contest?.name).toBe('Weekly 523');
  });

  it('distinguishes biweekly from weekly in the name', () => {
    const [contest] = parseLeetCodePayload(payload([BIWEEKLY]), NOW);
    expect(contest?.name).toBe('Biweekly 193');
  });

  it('drops contests that already ended', () => {
    const past = { ...WEEKLY, startTime: NOW.minus({ days: 3 }).toSeconds(), duration: 5400 };
    expect(parseLeetCodePayload(payload([past]), NOW)).toHaveLength(0);
  });

  it('keeps a contest that is in progress right now', () => {
    const running = { ...WEEKLY, startTime: NOW.minus({ minutes: 30 }).toSeconds(), duration: 5400 };
    const [contest] = parseLeetCodePayload(payload([running]), NOW);
    expect(contest?.start.toSeconds()).toBeLessThan(NOW.toSeconds());
  });

  it('keeps a contest starting exactly at now, matching the other three sources', () => {
    // Parsers only drop what has finished (end <= now); filterContests then applies
    // minLeadMinutes, so an at-the-boundary start is dropped there rather than here.
    // This is the same contract as codeforces/atcoder/codechef.
    const atNow = { ...WEEKLY, startTime: NOW.toSeconds(), duration: 5400 };
    expect(parseLeetCodePayload(payload([atNow]), NOW)).toHaveLength(1);
  });

  it('skips individual malformed rows instead of discarding the listing', () => {
    const contests = parseLeetCodePayload(
      payload([
        WEEKLY,
        { title: 'Broken', titleSlug: 'broken', startTime: 'not-a-number', duration: 5400 },
        { title: '', titleSlug: 'x', startTime: 1791685800, duration: 5400 },
        BIWEEKLY,
      ]),
      NOW,
    );
    expect(contests.map((c) => c.platformId)).toEqual(['weekly-contest-523', 'biweekly-contest-193']);
  });

  it('throws on a GraphQL errors array, which arrives with HTTP 400', () => {
    expect(() =>
      parseLeetCodePayload(
        {
          errors: [{ message: 'Cannot query field "isUpcoming" on type "ContestNode".' }],
          data: null,
        },
        NOW,
      ),
    ).toThrow(/Cannot query field "isUpcoming"/);
  });

  it('throws when both data and errors are absent', () => {
    expect(() => parseLeetCodePayload({}, NOW)).toThrow(/neither data.allContests nor errors/);
  });

  it('throws on a completely different payload shape', () => {
    expect(() => parseLeetCodePayload({ unexpected: true }, NOW)).toThrow(
      /neither data.allContests nor errors/,
    );
  });

  it('throws on a non-object payload', () => {
    expect(() => parseLeetCodePayload('nope', NOW)).toThrow(/Unexpected LeetCode payload/);
  });

  it('accepts extra fields GraphQL may add later', () => {
    const withExtras = { ...WEEKLY, isVirtual: true, prize: 3000 };
    expect(parseLeetCodePayload(payload([withExtras]), NOW)).toHaveLength(1);
  });

  it('handles the full ~700 row history without error', () => {
    const history = Array.from({ length: 700 }, (_, i) => ({
      title: `Weekly Contest ${500 + i}`,
      titleSlug: `weekly-contest-${500 + i}`,
      startTime: 1791685800 + i * 604800,
      duration: 5400,
    }));
    expect(parseLeetCodePayload(payload(history), NOW)).toHaveLength(700);
  });
});