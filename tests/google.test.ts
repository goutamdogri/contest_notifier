import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import {
  buildEventRequest,
  buildEventDescription,
  buildEventSummary,
  deterministicEventId,
} from '../src/google/calendar.js';
import {
  buildTaskNotes,
  buildTaskRequest,
  buildTaskTitle,
  parseKeyFromNotes,
  taskContentHash,
} from '../src/google/tasks.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import type { Config } from '../src/config.js';
import type { Contest } from '../src/models.js';

const TZ = 'Asia/Kolkata';

function config(): Config {
  return {
    ...DEFAULT_CONFIG,
    timezone: TZ,
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

function contest(overrides: Partial<Contest> = {}): Contest {
  const start = DateTime.fromISO('2026-10-03T12:00:00Z', { zone: 'utc' }); // 17:30 IST
  return {
    platform: 'atcoder',
    platformId: 'abc478',
    key: 'atcoder:abc478',
    name: 'AtCoder Beginner Contest 478',
    start,
    end: start.plus({ minutes: 100 }),
    url: 'https://atcoder.jp/contests/abc478',
    inProgress: false,
    warnings: [],
    ...overrides,
  };
}

describe('deterministicEventId', () => {
  it('is stable for the same contest', () => {
    expect(deterministicEventId(contest())).toBe(deterministicEventId(contest()));
  });

  it('differs between contests', () => {
    expect(deterministicEventId(contest())).not.toBe(
      deterministicEventId(contest({ key: 'atcoder:abc479', platformId: 'abc479' })),
    );
  });

  it('only uses base32hex characters accepted by the Calendar API', () => {
    // Allowed ids are lowercase a-v and 0-9, length 5-1024.
    for (let i = 0; i < 200; i++) {
      const id = deterministicEventId(contest({ key: `atcoder:contest-${i}` }));
      expect(id).toMatch(/^[a-v0-9]+$/);
      expect(id.length).toBeGreaterThanOrEqual(5);
      expect(id.length).toBeLessThanOrEqual(1024);
    }
  });
});

describe('buildEventRequest', () => {
  const { event, reminderPlan } = buildEventRequest(contest(), config());

  it('sets the Blueberry colour', () => {
    expect(event.colorId).toBe('9');
  });

  it('attaches the contest link to the description and to source.url', () => {
    expect(event.description).toContain('https://atcoder.jp/contests/abc478');
    expect(event.source?.url).toBe('https://atcoder.jp/contests/abc478');
  });

  it('turns reminders off and supplies all four overrides', () => {
    expect(event.reminders?.useDefault).toBe(false);
    const overrides = event.reminders?.overrides ?? [];
    expect(overrides).toHaveLength(4);
    expect(overrides.map((o) => o?.minutes)).toEqual([1440, 690, 120, 5]);
    expect(overrides.every((o) => o?.method === 'popup')).toBe(true);
  });

  it('never exceeds the 5-reminder cap the API enforces', () => {
    expect((event.reminders?.overrides ?? []).length).toBeLessThanOrEqual(5);
    expect(reminderPlan.reminders.length).toBeLessThanOrEqual(5);
  });

  it('sends start and end with an explicit IANA zone', () => {
    expect(event.start?.timeZone).toBe(TZ);
    expect(event.start?.dateTime).toBe('2026-10-03T17:30:00+05:30');
    expect(event.end?.dateTime).toBe('2026-10-03T19:10:00+05:30');
  });

  it('stamps a private extended property for dedup and drift detection', () => {
    expect(event.extendedProperties?.private?.cn_key).toBe('atcoder:abc478');
    expect(event.extendedProperties?.private?.cn_hash).toMatch(/^[0-9a-f]{32}$/);
  });

  it('uses the deterministic id so retries cannot duplicate the event', () => {
    expect(event.id).toBe(deterministicEventId(contest()));
  });

  it('honours a configured calendar colour', () => {
    const { event: custom } = buildEventRequest(contest(), { ...config(), calendarColorId: '4' });
    expect(custom.colorId).toBe('4');
  });
});

describe('buildEventSummary and description', () => {
  it('prefixes the platform', () => {
    expect(buildEventSummary(contest())).toBe('[AtCoder] AtCoder Beginner Contest 478');
    expect(buildEventSummary(contest({ platform: 'codeforces' }))).toBe('[Codeforces] AtCoder Beginner Contest 478');
    expect(buildEventSummary(contest({ platform: 'codechef' }))).toBe('[CodeChef] AtCoder Beginner Contest 478');
  });

  it('includes local start time, duration and the link', () => {
    const description = buildEventDescription(contest(), config());
    expect(description).toContain('Starts:');
    expect(description).toContain('Sat 03 Oct 2026, 17:30 Asia/Kolkata');
    expect(description).toContain('Duration: 1h 40m');
    expect(description).toContain('https://atcoder.jp/contests/abc478');
  });

  it('includes the rated range when the platform reports one', () => {
    expect(buildEventDescription(contest({ ratedRange: '1200 – 2799' }), config())).toContain(
      'Rated range: 1200 – 2799',
    );
  });

  it('formats sub-hour durations', () => {
    const description = buildEventDescription(contest({ end: contest().start.plus({ minutes: 45 }) }), config());
    expect(description).toContain('Duration: 45 min');
  });
});

describe('taskContentHash', () => {
  it('is stable for the same contest', () => {
    expect(taskContentHash(contest(), config())).toBe(taskContentHash(contest(), config()));
  });

  it('changes when the contest is renamed', () => {
    expect(taskContentHash(contest(), config())).not.toBe(
      taskContentHash(contest({ name: 'AtCoder Beginner Contest 479' }), config()),
    );
  });

  it('changes when the start time is revised', () => {
    expect(taskContentHash(contest(), config())).not.toBe(
      taskContentHash(contest({ start: contest().start.plus({ hours: 2 }) }), config()),
    );
  });

  it('changes when the link changes', () => {
    expect(taskContentHash(contest(), config())).not.toBe(
      taskContentHash(contest({ url: 'https://atcoder.jp/contests/abc479' }), config()),
    );
  });

  it('changes when the timezone changes, since the notes show local time', () => {
    expect(taskContentHash(contest(), config())).not.toBe(
      taskContentHash(contest(), { ...config(), timezone: 'Asia/Tokyo' }),
    );
  });

  it('is a 32-char hex string', () => {
    expect(taskContentHash(contest(), config())).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('google task', () => {
  it('embeds a parseable dedup key in the notes', () => {
    const task = buildTaskRequest(contest(), config());
    expect(parseKeyFromNotes(task.notes)).toBe('atcoder:abc478');
  });

  it('round-trips the key for every platform', () => {
    for (const platform of ['atcoder', 'codeforces', 'codechef'] as const) {
      const task = buildTaskRequest(contest({ platform }), config());
      expect(parseKeyFromNotes(task.notes)).toBe('atcoder:abc478');
    }
  });

  it('returns undefined for notes we did not write', () => {
    expect(parseKeyFromNotes('buy milk')).toBeUndefined();
    expect(parseKeyFromNotes('')).toBeUndefined();
    expect(parseKeyFromNotes(undefined)).toBeUndefined();
  });

  it('uses a date-only due value, because Google discards the time', () => {
    const task = buildTaskRequest(contest(), config());
    expect(task.due).toBe('2026-10-03T00:00:00Z');
  });

  it('keeps the local contest day rather than shifting across the date line', () => {
    // Start 17:30 IST is 12:00 UTC the same day, so the due date must not roll.
    const task = buildTaskRequest(contest(), config());
    expect(task.due?.startsWith('2026-10-03')).toBe(true);
  });

  it('sets status and never sends a reminders field', () => {
    const task = buildTaskRequest(contest(), config()) as Record<string, unknown>;
    expect(task.status).toBe('needsAction');
    // The Tasks API has no reminders field; sending one returns HTTP 400.
    expect(task.reminders).toBeUndefined();
  });

  it('names the task so it reads as an action', () => {
    expect(buildTaskTitle(contest())).toBe('Register for AtCoder: AtCoder Beginner Contest 478');
  });

  it('includes the contest link in the notes', () => {
    expect(buildTaskNotes(contest(), config())).toContain('https://atcoder.jp/contests/abc478');
  });
});
