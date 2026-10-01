import { DateTime } from 'luxon';
import type { Config } from '../config.js';
import type { Contest, Platform } from '../models.js';
import { log } from '../logger.js';
import { fetchCodeforces } from './codeforces.js';
import { fetchAtCoder } from './atcoder.js';
import { fetchCodeChef } from './codechef.js';
import { fetchLeetCode } from './leetcode.js';

export interface FetchOutcome {
  contests: Contest[];
  failures: Array<{ platform: Platform; error: string }>;
}

type Fetcher = (config: Config, now: DateTime) => Promise<Contest[]>;

const FETCHERS: Record<Platform, Fetcher> = {
  codeforces: fetchCodeforces,
  atcoder: fetchAtCoder,
  codechef: fetchCodeChef,
  leetcode: fetchLeetCode,
};

/**
 * Each source is isolated: CodeChef's undocumented endpoint can break or change
 * shape without taking Codeforces and AtCoder down with it. A partial run that
 * creates events from two of three sources is far better than no run at all.
 */
export async function fetchAll(config: Config, now: DateTime, enabled: Platform[]): Promise<FetchOutcome> {
  const results = await Promise.allSettled(
    enabled.map(async (platform) => {
      const contests = await FETCHERS[platform](config, now);
      log.info(`fetched ${contests.length} contest(s) from ${platform}`);
      return { platform, contests };
    }),
  );

  const contests: Contest[] = [];
  const failures: FetchOutcome['failures'] = [];

  results.forEach((result, index) => {
    const platform = enabled[index] as Platform;
    if (result.status === 'fulfilled') {
      contests.push(...result.value.contests);
    } else {
      const error = result.reason instanceof Error ? result.reason.message : String(result.reason);
      failures.push({ platform, error });
      log.error(`source failed: ${platform}`, { error });
    }
  });

  return { contests, failures };
}

/** Applies horizon and lead-time filters, then sorts by start time. */
export function filterContests(contests: Contest[], config: Config, now: DateTime): Contest[] {
  const horizonEnd = now.plus({ days: config.horizonDays });
  const minLead = now.plus({ minutes: config.filters.minLeadMinutes });

  return contests
    .filter((contest) => contest.start > minLead && contest.start <= horizonEnd)
    .sort((a, b) => a.start.toMillis() - b.start.toMillis());
}

export function groupByPlatform(contests: Contest[]): Record<Platform, Contest[]> {
  const grouped: Record<Platform, Contest[]> = {
    codeforces: [],
    atcoder: [],
    codechef: [],
    leetcode: [],
  };
  for (const contest of contests) grouped[contest.platform].push(contest);
  return grouped;
}
