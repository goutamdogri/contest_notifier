import { spawn } from 'node:child_process';
import type { Platform } from './models.js';
import { log } from './logger.js';

/**
 * Fires a desktop notification via notify-send. Best effort: if the tool is not
 * running inside a graphical session, or notify-send is missing, we log and move on.
 *
 * Used for two things: "we found something new", and "a provider went down".
 * The four contest reminders themselves are Google Calendar reminders and fire
 * regardless of whether this machine is awake.
 */
export function notifyDesktop(title: string, body: string, enabled: boolean): void {
  if (!enabled) return;

  const child = spawn('notify-send', ['--app-name=Contest Notifier', '--', title, body], {
    stdio: 'ignore',
    detached: true,
  });

  child.on('error', (err) => {
    log.debug('desktop notification unavailable', { error: err.message });
  });

  child.unref();
}

const PLATFORM_LABEL: Record<Platform, string> = {
  codeforces: 'Codeforces',
  atcoder: 'AtCoder',
  codechef: 'CodeChef',
  leetcode: 'LeetCode',
};

/**
 * Trims a raw fetch error down to something readable in a notification body.
 *
 * The retry boilerplate ("... failed after N attempt(s):") wraps the useful part, so
 * the cause after the colon is preferred, with the URL kept for context:
 *
 *   "GET https://host/path failed after 4 attempt(s): HTTP 429 Too Many Requests"
 *   -> "HTTP 429 Too Many Requests  (https://host/path, after 4 attempts)"
 */
export function formatOutageReason(error: string, maxLength = 300): string {
  const cleaned = error.replace(/\s+/g, ' ').trim();

  const retryMatch = /^(.*?)\s+failed after (\d+) attempt\(s\):\s*(.+)$/.exec(cleaned);
  if (retryMatch) {
    const [, prefix = '', attempts = '', cause = ''] = retryMatch;
    const url = /\b(https?:\/\/\S+?)(?=\s|$)/.exec(prefix)?.[1];
    const parts = [cause.trim()];
    if (url) parts.push(`(${url})`);
    parts.push(`after ${attempts} attempt${attempts === '1' ? '' : 's'}`);
    const joined = parts.join('  ');
    return joined.length > maxLength ? `${joined.slice(0, maxLength - 1)}…` : joined;
  }

  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength - 1)}…` : cleaned;
}

export interface OutageNotice {
  title: string;
  body: string;
}

/**
 * Decides which provider outages should raise a desktop notification.
 *
 * Returns one notice per unsuppressed platform so the caller can fire them all.
 * A platform is silenced by setting notifications.suppressOutageNotifications
 * for that platform to true, which is how a chronically flaky provider is muted
 * without losing alerting for the rest.
 */
export function outageNotices(
  failures: ReadonlyArray<{ platform: Platform; error: string }>,
  suppress: Partial<Record<Platform, boolean>> | undefined,
): OutageNotice[] {
  const notices: OutageNotice[] = [];
  for (const failure of failures) {
    if (suppress?.[failure.platform]) continue;
    const label = PLATFORM_LABEL[failure.platform] ?? failure.platform;
    notices.push({
      title: `Contest Notifier: ${label} feed unavailable`,
      body: formatOutageReason(failure.error),
    });
  }
  return notices;
}
