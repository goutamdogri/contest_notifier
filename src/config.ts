import { readFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface ReminderConfig {
  /** Google Calendar reminder method: "popup" or "email". */
  method: 'popup' | 'email';
  /** Treated as the target "N minutes before start". */
  oneDayBeforeMinutes: number;
  /** Local hour of the "that day at 6am" ping. */
  sixAmLocalHour: number;
  twoHoursBeforeMinutes: number;
  fiveMinutesBeforeMinutes: number;
}

export interface SourceConfig {
  enabled: boolean;
  /** Skip this source unless this many minutes have passed since its last fetch. */
  pollIntervalMinutes: number;
}

export interface Config {
  timezone: string;
  /** Only create events/tasks for contests starting within this many days. */
  horizonDays: number;
  calendarId: string;
  /**
   * Google Calendar event colour. "9" is Blueberry in the API palette
   * (classic #5484ed / modern #3f51b5). "8" is Graphite, not Blueberry.
   */
  calendarColorId: string;
  taskListName: string;
  reminders: ReminderConfig;
  filters: {
    /** Ignore contests starting sooner than this, so we never create dead reminders. */
    minLeadMinutes: number;
    /**
     * Some CodeChef contests are multi-session containers whose reported end is days
     * after the start. When the span exceeds this, fall back to the per-session length.
     */
    maxEventHours: number;
  };
  sources: Record<'codeforces' | 'atcoder' | 'codechef' | 'leetcode', SourceConfig>;
  userAgent: string;
  notifications: {
    desktop: boolean;
  };
  paths: {
    configDir: string;
    stateDir: string;
    tokenFile: string;
    credentialsFile: string;
    dbFile: string;
    logFile: string;
  };
}

export const DEFAULT_CONFIG: Omit<Config, 'paths'> = {
  timezone: 'Asia/Kolkata',
  horizonDays: 14,
  calendarId: 'primary',
  calendarColorId: '9',
  taskListName: 'Contests',
  reminders: {
    method: 'popup',
    oneDayBeforeMinutes: 1440,
    sixAmLocalHour: 6,
    twoHoursBeforeMinutes: 120,
    fiveMinutesBeforeMinutes: 5,
  },
  filters: {
    minLeadMinutes: 5,
    maxEventHours: 12,
  },
  sources: {
    codeforces: { enabled: true, pollIntervalMinutes: 360 },
    atcoder: { enabled: true, pollIntervalMinutes: 360 },
    codechef: { enabled: true, pollIntervalMinutes: 60 },
    leetcode: { enabled: true, pollIntervalMinutes: 360 },
  },
  userAgent: 'contest-notifier/1.0 (local, single-user)',
  notifications: { desktop: true },
};

function xdgDir(envVar: string, fallback: string): string {
  const value = process.env[envVar];
  const base = value && value.trim().length > 0 ? value : join(homedir(), fallback);
  return base;
}

export function resolvePaths(): Config['paths'] {
  const configDir = resolve(xdgDir('XDG_CONFIG_HOME', join('.config', 'contest-notifier')));
  const stateDir = resolve(xdgDir('XDG_STATE_HOME', join('.local', 'state', 'contest-notifier')));
  return {
    configDir,
    stateDir,
    tokenFile: join(configDir, 'token.json'),
    credentialsFile: join(configDir, 'credentials.json'),
    dbFile: join(stateDir, 'notifier.db'),
    logFile: join(stateDir, 'notifier.log'),
  };
}

/**
 * Locates the OAuth Desktop client JSON. Prefers the conventional
 * ~/.config/contest-notifier/credentials.json, otherwise picks up a
 * client_secret_*.json dropped anywhere up the directory tree from cwd.
 */
export function findCredentialsFile(paths: Config['paths']): string | undefined {
  if (existsSync(paths.credentialsFile)) return paths.credentialsFile;
  for (let dir = process.cwd(); ; dir = resolve(dir, '..')) {
    try {
      for (const name of readdirSync(dir)) {
        if (/^client_secret_.*\.json$/.test(name)) return join(dir, name);
      }
    } catch {
      // unreadable dir, keep walking up
    }
    const parent = resolve(dir, '..');
    if (parent === dir) return undefined;
  }
}

export function loadConfig(configPath?: string): Config {
  const paths = resolvePaths();
  const candidate = configPath
    ? resolve(configPath)
    : existsSync(join(paths.configDir, 'config.json'))
      ? join(paths.configDir, 'config.json')
      : resolve('config.json');

  let fileConfig: Partial<Config> = {};
  if (existsSync(candidate)) {
    try {
      fileConfig = JSON.parse(readFileSync(candidate, 'utf8')) as Partial<Config>;
    } catch (err) {
      throw new Error(`Could not parse config at ${candidate}: ${(err as Error).message}`);
    }
  }

  const merged: Config = {
    ...DEFAULT_CONFIG,
    ...fileConfig,
    reminders: { ...DEFAULT_CONFIG.reminders, ...(fileConfig.reminders ?? {}) },
    filters: { ...DEFAULT_CONFIG.filters, ...(fileConfig.filters ?? {}) },
    notifications: { ...DEFAULT_CONFIG.notifications, ...(fileConfig.notifications ?? {}) },
    sources: { ...DEFAULT_CONFIG.sources, ...(fileConfig.sources ?? {}) },
    paths,
  };

  if (!existsSync(paths.configDir)) mkdirSync(paths.configDir, { recursive: true, mode: 0o700 });
  if (!existsSync(paths.stateDir)) mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });

  return merged;
}
