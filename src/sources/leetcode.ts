import { DateTime } from 'luxon';
import { z } from 'zod';
import { postJson } from '../http.js';
import type { Config } from '../config.js';
import { makeContestKey, type Contest } from '../models.js';

/**
 * LeetCode has no documented public API and no iCal feed, and /contest/ HTML 403s
 * generic clients. Its internal GraphQL endpoint does accept a POST without
 * authentication, which is what we use here.
 *
 * Field notes, all verified against the live endpoint:
 *
 * - Introspection is blocked. `{ __type(name: "ContestNode") }` returns
 *   "Query unavailable", so the schema cannot be discovered; the field names below
 *   were established by probing and reading the resulting errors.
 * - `upcomingContests` is useless here: it returns only the single nearest Weekly
 *   Contest and never the Biweekly ones.
 * - `allContests` is the field that actually works. It returns the full history
 *   (~700 rows), newest first, and includes both Weekly and Biweekly contests.
 * - A `biweeklyContests` field does not exist; the error message helpfully lists
 *   allContests / upcomingContests / featuredContests / myContests as the options.
 * - `startTime` is a Unix epoch in seconds and `duration` is in seconds (5400 =
 *   90 minutes for every contest series).
 * - GraphQL reports unknown fields as HTTP 400 with an errors array rather than a
 *   transport failure, so the error path must be detected in the body too.
 */
const ENDPOINT = 'https://leetcode.com/graphql';

const QUERY = `{
  allContests {
    title
    titleSlug
    startTime
    duration
  }
}`;

const ContestSchema = z.object({
  title: z.string().min(1),
  titleSlug: z.string().min(1),
  startTime: z.number().int().positive(),
  duration: z.number().int().positive(),
});

/**
 * `data` is nullable because a schema error returns {"errors":[...],"data":null}.
 * Rejecting that shape at the schema layer would mask the useful errors array with
 * a generic "unexpected payload" message.
 */
const ResponseSchema = z.object({
  data: z
    .object({
      allContests: z.array(z.unknown()).nullable(),
    })
    .nullable()
    .optional(),
  errors: z
    .array(z.object({ message: z.string() }).passthrough())
    .optional(),
});

/**
 * "Weekly Contest 522" -> "Weekly 522".
 *
 * The series word is kept because "Contest 522" and "Contest 193" are otherwise
 * indistinguishable, and a weekly and a biweekly can run in the same week. "Weekly"
 * is kept rather than "Contest" because the branding matches the other sources.
 */
function normalizeName(title: string): string {
  return title.replace(/\s+Contest\s+/i, ' ');
}

export function parseLeetCodePayload(raw: unknown, now: DateTime): Contest[] {
  const parsed = ResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Unexpected LeetCode payload: ${parsed.error.message.slice(0, 300)}`);
  }

  // GraphQL schema errors arrive with HTTP 400, so a body-level check is required
  // or a renamed field would look like "no contests found" rather than an error.
  if (parsed.data.errors?.length) {
    throw new Error(`LeetCode GraphQL error: ${parsed.data.errors.map((e) => e.message).join('; ').slice(0, 300)}`);
  }

  const rows = parsed.data.data?.allContests;
  if (!rows) {
    throw new Error('LeetCode response contained neither data.allContests nor errors');
  }

  const contests: Contest[] = [];

  for (const row of rows) {
    const rowResult = ContestSchema.safeParse(row);
    if (!rowResult.success) continue;
    const entry = rowResult.data;

    const start = DateTime.fromSeconds(entry.startTime, { zone: 'utc' });
    const end = start.plus({ seconds: entry.duration });
    if (!start.isValid || !end.isValid) continue;
    if (end <= now) continue;

    // titleSlug is stable and unique ("weekly-contest-522"), so it is the id.
    // LeetCode has no separate numeric contest id exposed here.
    const platformId = entry.titleSlug;

    contests.push({
      platform: 'leetcode',
      platformId,
      key: makeContestKey('leetcode', platformId),
      name: normalizeName(entry.title),
      start,
      end,
      url: `https://leetcode.com/contest/${platformId}/`,
      inProgress: start <= now,
      warnings: [],
    });
  }

  return contests;
}

export async function fetchLeetCode(config: Config, now: DateTime): Promise<Contest[]> {
  const payload = await postJson<unknown>(ENDPOINT, { query: QUERY }, {
    userAgent: config.userAgent,
    headers: {
      origin: 'https://leetcode.com',
      referer: 'https://leetcode.com/contest/',
    },
  });

  return parseLeetCodePayload(payload, now);
}