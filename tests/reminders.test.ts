import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { sixAmAnchor, planReminders, MAX_REMINDER_OVERRIDES } from '../src/reminders.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import type { Config } from '../src/config.js';
import type { Contest } from '../src/models.js';

const TZ = 'Asia/Kolkata';

function config(overrides: Partial<Config['reminders']> = {}): Config {
  return {
    ...DEFAULT_CONFIG,
    timezone: TZ,
    reminders: { ...DEFAULT_CONFIG.reminders, ...overrides },
    paths: {
      configDir: '/tmp',
      stateDir: '/tmp',
      tokenFile: '/tmp/token.json',
      credentialsFile: '/tmp/creds.json',
      dbFile: '/tmp/db.sqlite',
      logFile: '/tmp/log',
    },
  };
}

function contest(startIso: string, minutes = 100): Contest {
  const start = DateTime.fromISO(startIso, { zone: 'utc' });
  return {
    platform: 'atcoder',
    platformId: 'abc478',
    key: 'atcoder:abc478',
    name: 'AtCoder Beginner Contest 478',
    start,
    end: start.plus({ minutes }),
    url: 'https://atcoder.jp/contests/abc478',
    inProgress: false,
    warnings: [],
  };
}

describe('sixAmAnchor', () => {
  it('anchors at 06:00 local on the contest day when the contest starts later', () => {
    const start = DateTime.fromISO('2026-10-03T12:00:00Z', { zone: 'utc' }); // 17:30 IST
    const anchor = sixAmAnchor(start, 6, TZ);
    expect(anchor.setZone(TZ).toFormat('yyyy-LL-dd HH:mm')).toBe('2026-10-03 06:00');
  });

  it('walks back to the previous day when the contest starts at or before the anchor', () => {
    // CodeChef PLACEPREP10 starts 00:00:32 IST; 06:00 the same day would be after the start.
    const start = DateTime.fromISO('2026-10-02T18:30:32Z', { zone: 'utc' }); // 00:00:32 IST
    const anchor = sixAmAnchor(start, 6, TZ);
    expect(anchor.setZone(TZ).toFormat('yyyy-LL-dd HH:mm')).toBe('2026-10-02 06:00');
    expect(anchor < start).toBe(true);
  });

  it('fires at the anchor itself when the contest starts exactly at 06:00', () => {
    const start = DateTime.fromISO('2026-10-03T00:30:00Z', { zone: 'utc' }); // 06:00 IST exactly
    const anchor = sixAmAnchor(start, 6, TZ);
    expect(anchor.setZone(TZ).toFormat('yyyy-LL-dd HH:mm')).toBe('2026-10-03 06:00');
    // 0 minutes before start is valid and is the honest answer here: the contest
    // begins at 06:00, so "that day at 6am" is the start itself.
    expect(anchor.toMillis()).toBe(start.toMillis());
  });

  it('uses the configured local zone, not the zone of the instant', () => {
    // Regression: the instant is UTC, so deriving the zone from it anchored at
    // 06:00 UTC == 11:30 IST and silently broke the 6am reminder.
    const start = DateTime.fromISO('2026-10-03T12:00:00Z', { zone: 'utc' });
    expect(start.zoneName).toBe('UTC');
    const anchor = sixAmAnchor(start, 6, TZ);
    expect(anchor.setZone(TZ).toFormat('yyyy-LL-dd HH:mm')).toBe('2026-10-03 06:00');
    expect(anchor.toUTC().toISO()).toBe('2026-10-03T00:30:00.000Z');
  });
});

describe('planReminders', () => {
  it('emits the four requested notification points at the right wall-clock times', () => {
    const plan = planReminders(contest('2026-10-03T12:00:00Z'), config()); // start 17:30 IST

    expect(plan.reminders.map((r) => r.minutes)).toEqual([1440, 690, 120, 5]);
    expect(plan.reminders.map((r) => r.method)).toEqual(['popup', 'popup', 'popup', 'popup']);
    expect(plan.dropped).toEqual([]);

    // Verify each one against the literal requirement rather than trusting offsets.
    const startLocal = DateTime.fromISO('2026-10-03T12:00:00Z', { zone: 'utc' }).setZone(TZ);
    const fireTimes = plan.reminders.map(
      (r) => startLocal.minus({ minutes: r.minutes }).toFormat('yyyy-LL-dd HH:mm'),
    );
    expect(fireTimes).toEqual([
      '2026-10-02 17:30', // 1 day before
      '2026-10-03 06:00', // that day at 6am
      '2026-10-03 15:30', // 2 hours before
      '2026-10-03 17:25', // 5 minutes before
    ]);
  });

  it('sorts reminders from furthest out to closest', () => {
    const plan = planReminders(contest('2026-10-03T12:00:00Z'), config());
    const minutes = plan.reminders.map((r) => r.minutes);
    expect([...minutes].sort((a, b) => b - a)).toEqual(minutes);
  });

  it('rolls the 6am anchor back for a contest starting at midnight', () => {
    const plan = planReminders(contest('2026-10-02T18:30:32Z'), config()); // 00:00:32 IST
    const sixAm = plan.reminders.find((r) => r.label.includes('6:00'));
    expect(sixAm).toBeDefined();
    expect(sixAm?.firesAtLocal).toContain('06:00:00');
    expect(sixAm?.minutes).toBeGreaterThan(0);
  });

  it('rounds sub-minute start times to the nearest minute', () => {
    // 00:00:32 IST start: the 6am gap is 18h 0m 32s == 1080.53 minutes.
    const plan = planReminders(contest('2026-10-02T18:30:32Z'), config());
    const sixAm = plan.reminders.find((r) => r.label.includes('6:00'));
    expect(sixAm?.minutes).toBe(1081);
  });

  it('deduplicates reminders that collapse onto the same offset', () => {
    // A contest starting exactly at 06:00 makes "1 day before" and "that day at 6am"
    // resolve to different times, so instead force a collision by making the two
    // configured offsets identical.
    const plan = planReminders(
      contest('2026-10-03T12:00:00Z'),
      config({ oneDayBeforeMinutes: 120, twoHoursBeforeMinutes: 120 }),
    );
    const minutes = plan.reminders.map((r) => r.minutes);
    expect(new Set(minutes).size).toBe(minutes.length);
    expect(plan.dropped.some((d) => d.includes('duplicate'))).toBe(true);
  });

  it('never exceeds the 5-override API cap', () => {
    const plan = planReminders(contest('2026-10-03T12:00:00Z'), config());
    expect(plan.reminders.length).toBeLessThanOrEqual(MAX_REMINDER_OVERRIDES);
  });

  it('honours a different configured anchor hour', () => {
    const plan = planReminders(contest('2026-10-03T12:00:00Z'), config({ sixAmLocalHour: 8 }));
    const anchor = plan.reminders.find((r) => r.label.includes('8:00'));
    expect(anchor?.minutes).toBe(570); // 08:00 IST -> 17:30 IST is 9.5h
  });

  it('respects a non-Asia timezone in config', () => {
    const tokyoConfig = { ...config(), timezone: 'Asia/Tokyo' };
    const plan = planReminders(contest('2026-10-03T12:00:00Z'), tokyoConfig); // 21:00 JST
    const anchor = plan.reminders.find((r) => r.label.includes('6:00'));
    expect(anchor?.minutes).toBe(900); // 06:00 JST -> 21:00 JST
  });

  it('rejects an invalid timezone rather than silently producing garbage', () => {
    expect(() => planReminders(contest('2026-10-03T12:00:00Z'), { ...config(), timezone: 'Mars/Olympus' })).toThrow(
      /Invalid IANA timezone/,
    );
  });

  it('supports email as the reminder method', () => {
    const plan = planReminders(contest('2026-10-03T12:00:00Z'), config({ method: 'email' }));
    expect(plan.reminders.every((r) => r.method === 'email')).toBe(true);
  });
});
