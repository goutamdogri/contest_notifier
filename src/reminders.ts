import { DateTime } from 'luxon';
import type { Config } from './config.js';
import type { Contest } from './models.js';

/** Google Calendar rejects reminders outside this inclusive range (4 weeks). */
export const MIN_REMINDER_MINUTES = 0;
export const MAX_REMINDER_MINUTES = 40320;
/** Google Calendar caps override reminders per event at 5. */
export const MAX_REMINDER_OVERRIDES = 5;

export interface PlannedReminder {
  method: 'popup' | 'email';
  minutes: number;
  /** Absolute local time this reminder will fire at, for logging and dry runs. */
  firesAtLocal: string;
  /** Human label matching the original requirement. */
  label: string;
  /** Label plus resolved wall-clock fire time, for logs and dry runs. */
  describe(): string;
}

export interface ReminderPlan {
  reminders: PlannedReminder[];
  /** Targets that could not be expressed as a valid minutes-before offset. */
  dropped: string[];
}

function assertValidZone(timezone: string): void {
  const probe = DateTime.now().setZone(timezone);
  if (!probe.isValid) {
    throw new Error(`Invalid IANA timezone in config: ${timezone} (${probe.invalidReason})`);
  }
}

/**
 * The "that day at 06:00 local" anchor.
 *
 * Calendar reminders are expressed as a fixed number of minutes before the start,
 * so a wall-clock time only works by measuring the gap to it. If the contest starts
 * at or before the anchor hour, 06:00 on the contest day would fall *after* the
 * start, so we walk back to the previous day's 06:00 instead.
 *
 * `zone` must be the configured local zone, NOT `start.zone`: every source hands us
 * UTC datetimes, so deriving the zone from the instant would silently anchor at
 * 06:00 UTC instead of 06:00 local.
 */
export function sixAmAnchor(start: DateTime, localHour: number, zone: string): DateTime {
  const candidate = start.setZone(zone).startOf('day').set({ hour: localHour });
  return candidate > start ? candidate.minus({ days: 1 }) : candidate;
}

/**
 * Converts the four requested notification points into Calendar minutes-before
 * overrides, then filters/dedupes/caps them to what the API will actually accept.
 */
export function planReminders(contest: Contest, config: Config): ReminderPlan {
  assertValidZone(config.timezone);
  const method = config.reminders.method;
  const start = contest.start.setZone(config.timezone);
  const dropped: string[] = [];

  const targets: Array<{ label: string; at: DateTime }> = [
    {
      label: '1 day before',
      at: start.minus({ minutes: config.reminders.oneDayBeforeMinutes }),
    },
    {
      label: `that day at ${config.reminders.sixAmLocalHour}:00 local`,
      at: sixAmAnchor(contest.start, config.reminders.sixAmLocalHour, config.timezone),
    },
    {
      label: '2 hours before',
      at: start.minus({ minutes: config.reminders.twoHoursBeforeMinutes }),
    },
    {
      label: '5 minutes before',
      at: start.minus({ minutes: config.reminders.fiveMinutesBeforeMinutes }),
    },
  ];

  const seen = new Set<number>();
  const reminders: PlannedReminder[] = [];

  for (const target of targets) {
    // Google wants a positive count of minutes *before* the start, so measure
    // start -> target rather than target -> start.
    const rawMinutes = start.diff(target.at, 'minutes').minutes;

    if (!Number.isFinite(rawMinutes)) {
      dropped.push(`${target.label}: uncomputable offset`);
      continue;
    }

    // Google accepts integer minutes only. Sub-minute contest start times
    // (CodeChef reports seconds) round to the nearest minute, +/-30s of drift.
    const minutes = Math.round(rawMinutes);

    if (minutes < MIN_REMINDER_MINUTES) {
      dropped.push(`${target.label}: already past (${minutes} min before start)`);
      continue;
    }
    if (minutes > MAX_REMINDER_MINUTES) {
      dropped.push(`${target.label}: beyond 4-week API limit (${minutes} min)`);
      continue;
    }
    if (seen.has(minutes)) {
      dropped.push(`${target.label}: duplicate of another reminder (${minutes} min)`);
      continue;
    }
    if (reminders.length >= MAX_REMINDER_OVERRIDES) {
      dropped.push(`${target.label}: exceeds ${MAX_REMINDER_OVERRIDES}-reminder API cap`);
      continue;
    }

    seen.add(minutes);
    reminders.push({
      method,
      minutes,
      firesAtLocal: target.at.setZone(config.timezone).toFormat('ccc dd LLL HH:mm:ss ZZZZ'),
      label: target.label,
      describe() {
        return `${this.label} (${this.minutes}m before) fires ${this.firesAtLocal}`;
      },
    });
  }

  reminders.sort((a, b) => b.minutes - a.minutes);
  return { reminders, dropped };
}
