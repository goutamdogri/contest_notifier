import { DateTime } from 'luxon';
import { z } from 'zod';
import { fetchJson } from '../http.js';
import type { Config } from '../config.js';
import { makeContestKey, type Contest } from '../models.js';

const ENDPOINT = 'https://codeforces.com/api/contest.list?gym=false';

const ContestSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  type: z.string(),
  phase: z.string(),
  durationSeconds: z.number().int().nonnegative(),
  startTimeSeconds: z.number().int().positive(),
});

const ResponseSchema = z.object({
  status: z.string(),
  comment: z.string().optional(),
  // Rows are validated individually so one unexpected contest cannot discard the
  // entire listing of 2000+ contests. Absent on error responses such as
  // {"status":"FAILED","comment":"Call limit exceeded"}.
  result: z.array(z.unknown()).optional().default([]),
});

/**
 * Codeforces has an official public API, but `contest.list` always returns the
 * entire history (2000+ contests, ~400 KB) with no server-side phase filter.
 * It also has no endTimeSeconds, so the end must be computed from the duration.
 */
export function parseCodeforcesPayload(raw: unknown, now: DateTime): Contest[] {
  const parsed = ResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Unexpected Codeforces payload: ${parsed.error.message.slice(0, 300)}`);
  }
  if (parsed.data.status !== 'OK') {
    // "Call limit exceeded" is the documented throttle response (1 req / 2 s).
    throw new Error(`Codeforces API returned ${parsed.data.status}: ${parsed.data.comment ?? 'no comment'}`);
  }

  const contests: Contest[] = [];
  for (const row of parsed.data.result) {
    const rowResult = ContestSchema.safeParse(row);
    if (!rowResult.success) continue;
    const entry = rowResult.data;
    if (entry.phase === 'FINISHED') continue;
    // Schedules are occasionally announced before a start time exists.
    if (!Number.isFinite(entry.startTimeSeconds) || entry.startTimeSeconds <= 0) continue;

    const start = DateTime.fromSeconds(entry.startTimeSeconds, { zone: 'utc' });
    const end = start.plus({ seconds: entry.durationSeconds });
    if (!start.isValid) continue;
    if (end <= now) continue;

    contests.push({
      platform: 'codeforces',
      platformId: String(entry.id),
      key: makeContestKey('codeforces', String(entry.id)),
      name: entry.name,
      start,
      end,
      url: `https://codeforces.com/contest/${entry.id}`,
      inProgress: entry.phase !== 'BEFORE',
      warnings: [],
    });
  }

  return contests;
}

export async function fetchCodeforces(config: Config, now: DateTime): Promise<Contest[]> {
  const raw = await fetchJson<unknown>(ENDPOINT, { userAgent: config.userAgent });
  return parseCodeforcesPayload(raw, now);
}
