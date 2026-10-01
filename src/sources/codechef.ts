import { DateTime } from 'luxon';
import { z } from 'zod';
import { fetchJson } from '../http.js';
import type { Config } from '../config.js';
import { makeContestKey, type Contest } from '../models.js';

/**
 * CodeChef's official API is OAuth-gated and unusable anonymously, so this uses
 * the undocumented internal endpoint the website itself calls.
 *
 * Two traps worth remembering:
 *  - `/api/list/contests/upcoming`, `/past` and `/current` all return the 20
 *    OLDEST contests ever run (2009) with `status: "success"`. Use `/future`.
 *  - This endpoint is unversioned and unvalidated upstream, so every field is
 *    parsed defensively and any single bad row is skipped rather than fatal.
 */
const ENDPOINT = 'https://www.codechef.com/api/list/contests/future';

const ContestSchema = z.object({
  contest_id: z.union([z.string(), z.number()]),
  contest_code: z.string().min(1),
  contest_name: z.string(),
  contest_start_date_iso: z.string(),
  contest_end_date_iso: z.string(),
  contest_duration: z.union([z.string(), z.number()]),
});

const ResponseSchema = z.object({
  status: z.string(),
  message: z.string().optional(),
  contests: z.array(z.unknown()),
});

export function parseCodeChefPayload(raw: unknown, config: Config, now: DateTime): Contest[] {
  const envelope = ResponseSchema.safeParse(raw);
  if (!envelope.success) {
    throw new Error(`Unexpected CodeChef payload: ${envelope.error.message.slice(0, 300)}`);
  }
  if (envelope.data.status !== 'success') {
    throw new Error(`CodeChef returned status=${envelope.data.status}: ${envelope.data.message ?? ''}`);
  }

  const contests: Contest[] = [];
  for (const row of envelope.data.contests) {
    const parsed = ContestSchema.safeParse(row);
    if (!parsed.success) continue;
    const entry = parsed.data;

    // Use the ISO fields. The plain date strings carry no offset and contain a
    // double space before the time ("03 Oct 2026  00:00:32").
    const start = DateTime.fromISO(entry.contest_start_date_iso);
    const parsedEnd = DateTime.fromISO(entry.contest_end_date_iso);
    if (!start.isValid || !parsedEnd.isValid) continue;
    if (parsedEnd <= now) continue;
    let end = parsedEnd;

    const warnings: string[] = [];
    const declaredMinutes = Number(entry.contest_duration);
    const wallclockMinutes = end.diff(start, 'minutes').minutes;

    // Recurring containers such as "Placement Prep Weekends" report a per-session
    // duration but an end date days away. Trust the declared session length
    // instead of scheduling a multi-day calendar block.
    const maxEventHours = config.filters.maxEventHours;
    if (
      Number.isFinite(declaredMinutes) &&
      declaredMinutes > 0 &&
      wallclockMinutes > maxEventHours * 60
    ) {
      warnings.push(
        `multi-session container: API end is ${Math.round(wallclockMinutes / 60)}h after start, ` +
          `using declared ${declaredMinutes}min session length`,
      );
      end = start.plus({ minutes: declaredMinutes });
    }

    const name = entry.contest_name.replace(/\s+/g, ' ').trim();
    const contest: Contest = {
      platform: 'codechef',
      platformId: entry.contest_code,
      key: makeContestKey('codechef', entry.contest_code),
      name,
      start,
      end,
      url: `https://www.codechef.com/${entry.contest_code}`,
      inProgress: start <= now,
      warnings,
    };
    contests.push(contest);
  }

  return contests;
}

export async function fetchCodeChef(config: Config, now: DateTime): Promise<Contest[]> {
  const raw = await fetchJson<unknown>(ENDPOINT, { userAgent: config.userAgent });
  return parseCodeChefPayload(raw, config, now);
}
