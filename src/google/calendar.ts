import { createHash } from 'node:crypto';
import type { calendar_v3 } from 'googleapis';
import { DateTime } from 'luxon';
import type { Config } from '../config.js';
import type { Contest } from '../models.js';
import { contestContentHash, contestDurationMinutes } from '../models.js';
import { planReminders } from '../reminders.js';
import { log } from '../logger.js';

const PLATFORM_LABEL: Record<Contest['platform'], string> = {
  codeforces: 'Codeforces',
  atcoder: 'AtCoder',
  codechef: 'CodeChef',
  leetcode: 'LeetCode',
};

/**
 * Calendar event ids must be base32hex: characters a-v and 0-9 only. A sha256 hex
 * digest is a subset of that alphabet, so hashing the contest key gives us an id
 * that is stable across runs. Re-inserting the same body then becomes a
 * server-side no-op (409 Conflict), which makes retries after a crash safe.
 */
export function deterministicEventId(contest: Contest): string {
  const digest = createHash('sha256').update(contest.key).digest('hex');
  return `cn${digest.slice(0, 30)}`;
}

export function buildEventSummary(contest: Contest): string {
  return `[${PLATFORM_LABEL[contest.platform]}] ${contest.name}`;
}

export function buildEventDescription(contest: Contest, config: Config): string {
  const zone = config.timezone;
  const startLocal = contest.start.setZone(zone);
  const endLocal = contest.end.setZone(zone);
  const sameDay = startLocal.hasSame(endLocal, 'day');

  const lines: string[] = [
    `${PLATFORM_LABEL[contest.platform]} contest`,
    `Starts: ${startLocal.toFormat('ccc dd LLL yyyy, HH:mm')} ${zone}`,
    `Ends: ${sameDay ? endLocal.toFormat('HH:mm') : endLocal.toFormat('ccc dd LLL, HH:mm')} ${zone}`,
    `Duration: ${formatDuration(contestDurationMinutes(contest))}`,
  ];

  if (contest.ratedRange) lines.push(`Rated range: ${contest.ratedRange}`);
  lines.push('', contest.url);

  return lines.join('\n');
}

function formatDuration(totalMinutes: number): string {
  if (totalMinutes < 60) return `${totalMinutes} min`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

/**
 * Full request body for events.insert. Exported so the dry-run command can print
 * exactly what would be sent, and so tests can assert on it without a network call.
 */
export function buildEventRequest(
  contest: Contest,
  config: Config,
): { event: calendar_v3.Schema$Event; reminderPlan: ReturnType<typeof planReminders> } {
  const plan = planReminders(contest, config);
  const zone = config.timezone;

  const event: calendar_v3.Schema$Event = {
    id: deterministicEventId(contest),
    summary: buildEventSummary(contest),
    description: buildEventDescription(contest, config),
    start: { dateTime: contest.start.setZone(zone).toISO({ suppressMilliseconds: true }), timeZone: zone },
    end: { dateTime: contest.end.setZone(zone).toISO({ suppressMilliseconds: true }), timeZone: zone },
    colorId: config.calendarColorId,
    status: 'confirmed',
    transparency: 'opaque',
    visibility: 'default',
    // source.url is what makes the event show "Created by ..." with a clickable link.
    source: { title: PLATFORM_LABEL[contest.platform], url: contest.url },
    reminders: {
      useDefault: false,
      overrides: plan.reminders.map((r) => ({ method: r.method, minutes: r.minutes })),
    },
    extendedProperties: {
      private: {
        cn_key: contest.key,
        cn_hash: contestContentHash(contest),
        cn_platform: contest.platform,
      },
    },
  };

  return { event, reminderPlan: plan };
}

export interface CalendarSyncResult {
  created: string[];
  updated: string[];
  unchanged: string[];
  failed: Array<{ key: string; error: string }>;
}

interface ExistingEvent {
  id: string | null | undefined;
  summary: string | undefined;
  start: { dateTime?: string | null } | undefined;
  end: { dateTime?: string | null } | undefined;
  colorId: string | null | undefined;
  source?: { url?: string | null } | null;
  reminders?: { useDefault?: boolean | null; overrides?: Array<{ method?: string | null; minutes?: number | null } | null> | null } | null;
  extendedProperties?: { private?: Record<string, string> | null } | null;
}

function eventMatches(event: calendar_v3.Schema$Event, desired: calendar_v3.Schema$Event): boolean {
  const existing = event as ExistingEvent;
  if ((existing.summary ?? '') !== (desired.summary ?? '')) return false;
  if ((existing.start?.dateTime ?? '') !== (desired.start?.dateTime ?? '')) return false;
  if ((existing.end?.dateTime ?? '') !== (desired.end?.dateTime ?? '')) return false;
  if ((existing.colorId ?? '') !== (desired.colorId ?? '')) return false;
  if ((existing.source?.url ?? '') !== (desired.source?.url ?? '')) return false;

  const desiredOverrides = (desired.reminders?.overrides ?? [])
    .map((o) => (o ? `${o.method}:${o.minutes}` : ''))
    .sort()
    .join(',');
  const existingOverrides = (existing.reminders?.overrides ?? [])
    .map((o) => (o ? `${o.method}:${o.minutes}` : ''))
    .sort()
    .join(',');
  if (desiredOverrides !== existingOverrides) return false;
  if (existing.reminders?.useDefault !== false) return false;

  return true;
}

/**
 * Creates or updates one event.
 *
 * `knownHash` is the content hash recorded when we last synced this contest. If it
 * still matches, the platform has not revised the contest and we skip the write
 * entirely; that keeps routine runs off the Calendar quota.
 */
export async function syncContestEvent(
  clients: { calendar: calendar_v3.Calendar },
  contest: Contest,
  config: Config,
  knownHash: string | undefined,
): Promise<{ outcome: 'created' | 'updated' | 'unchanged'; eventId: string }> {
  const { event, reminderPlan } = buildEventRequest(contest, config);
  const desiredHash = contestContentHash(contest);
  const calendarId = config.calendarId;

  for (const dropped of reminderPlan.dropped) {
    log.warn('reminder not representable as a Calendar offset', { key: contest.key, reason: dropped });
  }

  // We still send the write when the hash is unchanged but we have never confirmed
  // an event id for this contest, since a previous run may have crashed midway.
  if (knownHash === desiredHash && knownHash !== undefined) {
    try {
      const existing = await clients.calendar.events.get({
        calendarId,
        eventId: event.id!,
      });
      if (eventMatches(existing.data, event)) {
        return { outcome: 'unchanged', eventId: event.id! };
      }
    } catch (err) {
      // 404 means the deterministic id was never created (or the event was deleted
      // by hand); fall through and insert it.
      if (!isNotFound(err)) throw err;
    }
  }

  try {
    const created = await clients.calendar.events.insert({
      calendarId,
      requestBody: event,
      // Reminders must be created with the event; sendUpdates is irrelevant here
      // because the event has no attendees, but explicit is clearer.
      sendUpdates: 'none',
    });
    const id = created.data.id ?? event.id!;
    log.info('created calendar event', {
      key: contest.key,
      eventId: id,
      colorId: event.colorId,
      reminders: reminderPlan.reminders.map((r) => r.minutes).join('/'),
    });
    return { outcome: 'created', eventId: id };
  } catch (err) {
    if (isConflict(err)) {
      // Deterministic id already present: patch instead of duplicating.
      const current = await clients.calendar.events.get({ calendarId, eventId: event.id! });
      const patched = await clients.calendar.events.patch({
        calendarId,
        eventId: event.id!,
        requestBody: { ...event, etag: current.data.etag },
      });
      log.info('updated existing calendar event', { key: contest.key, eventId: event.id! });
      return { outcome: 'updated', eventId: patched.data.id ?? event.id! };
    }
    throw err;
  }
}

/** luxon's toISO() is typed string | null; the Calendar API needs a real string. */
function isoUtc(dt: DateTime): string {
  const iso = dt.toUTC().toISO();
  if (iso === null) throw new Error(`Could not format datetime: ${dt.invalidExplanation ?? 'unknown reason'}`);
  return iso;
}

/**
 * Reconciles local state against Google after the sqlite cache was lost.
 *
 * events.list only accepts privateExtendedProperty as "name=value", so there is no
 * way to ask "give me every event that has any cn_key". Instead we page the
 * relevant time window once and filter on the private property client-side.
 */
export async function discoverExistingEvents(
  clients: { calendar: calendar_v3.Calendar },
  config: Config,
  timeMin: DateTime,
  timeMax: DateTime,
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  let pageToken: string | undefined;

  do {
    const res = await clients.calendar.events.list({
      calendarId: config.calendarId,
      timeMin: isoUtc(timeMin),
      timeMax: isoUtc(timeMax),
      maxResults: 2500,
      singleEvents: false,
      showDeleted: false,
      ...(pageToken === undefined ? {} : { pageToken }),
    });

    for (const item of res.data.items ?? []) {
      const key = item.extendedProperties?.private?.cn_key;
      if (key && item.id) found.set(key, item.id);
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  return found;
}

export function isNotFound(err: unknown): boolean {
  return readStatus(err) === 404;
}

export function isConflict(err: unknown): boolean {
  return readStatus(err) === 409;
}

export function readStatus(err: unknown): number | undefined {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'number') return code;
    if (typeof code === 'string') return Number(code);
  }
  if (err && typeof err === 'object' && 'response' in err) {
    const status = (err as { response?: { status?: unknown } }).response?.status;
    if (typeof status === 'number') return status;
  }
  return undefined;
}
