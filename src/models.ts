import { createHash } from 'node:crypto';
import type { DateTime } from 'luxon';

export type Platform = 'codeforces' | 'atcoder' | 'codechef' | 'leetcode';

export const PLATFORMS: readonly Platform[] = ['codeforces', 'atcoder', 'codechef', 'leetcode'];

export interface Contest {
  platform: Platform;
  /** Identifier as the platform itself knows it: "2261", "abc478", "START258". */
  platformId: string;
  /** Globally unique dedup key, "<platform>:<platformId>". */
  key: string;
  name: string;
  start: DateTime;
  end: DateTime;
  url: string;
  /** AtCoder's rated range, e.g. "1200 - 2799". Undefined elsewhere. */
  ratedRange?: string;
  /** Source reported the contest as already running. */
  inProgress: boolean;
  /** Non-fatal data-quality notes, surfaced in logs and in the event description. */
  warnings: string[];
}

export function makeContestKey(platform: Platform, platformId: string): string {
  return `${platform}:${platformId}`;
}

/**
 * Fingerprint of the fields we push to Google. When this changes for an existing
 * key we know the platform revised the contest and the remote copy needs patching.
 */
export function contestContentHash(contest: Contest): string {
  return createHash('sha256')
    .update(
      [
        contest.name,
        contest.start.toUTC().toISO(),
        contest.end.toUTC().toISO(),
        contest.url,
        contest.ratedRange ?? '',
      ].join('\u0000'),
    )
    .digest('hex')
    .slice(0, 32);
}

export function contestDurationMinutes(contest: Contest): number {
  return Math.round(contest.end.diff(contest.start, 'minutes').minutes);
}
