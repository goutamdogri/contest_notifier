import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_ROTATIONS = 3;

let logFile: string | undefined;
let fileLevel: LogLevel = 'info';
let consoleLevel: LogLevel = 'info';

/**
 * `fileLevel` and `consoleLevel` are deliberately separate. The systemd service runs
 * with --quiet so the journal is not spammed every hour, and a single shared level
 * meant --quiet also silenced the log file, leaving background runs with no
 * persistent record at all.
 */
export function initLogger(
  file: string | undefined,
  console: LogLevel = 'info',
  fileLevelOverride?: LogLevel,
): void {
  logFile = file;
  consoleLevel = console;
  fileLevel = fileLevelOverride ?? 'info';
  if (file) {
    const dir = dirname(file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

function rotateIfNeeded(file: string): void {
  if (!existsSync(file)) return;
  if (statSync(file).size < MAX_BYTES) return;
  for (let i = MAX_ROTATIONS - 1; i >= 1; i--) {
    const from = `${file}.${i}`;
    const to = `${file}.${i + 1}`;
    if (existsSync(from)) {
      try {
        renameSync(from, to);
      } catch {
        /* best effort */
      }
    }
  }
  try {
    renameSync(file, `${file}.1`);
  } catch {
    /* best effort */
  }
}

function write(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
  const toFile = logFile && LEVEL_ORDER[level] >= LEVEL_ORDER[fileLevel];
  const toConsole = LEVEL_ORDER[level] >= LEVEL_ORDER[consoleLevel];
  // A debug line with --quiet and no file is not worth formatting.
  if (!toFile && !toConsole) return;

  const extras = fields
    ? ' ' +
      Object.entries(fields)
        .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
        .join(' ')
    : '';
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${message}${extras}\n`;

  if (toFile && logFile) {
    try {
      rotateIfNeeded(logFile);
      appendFileSync(logFile, line, { mode: 0o600 });
    } catch {
      /* never let logging kill the run */
    }
  }

  if (toConsole) {
    const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
    stream.write(line);
  }
}

export const log = {
  debug: (m: string, f?: Record<string, unknown>) => write('debug', m, f),
  info: (m: string, f?: Record<string, unknown>) => write('info', m, f),
  warn: (m: string, f?: Record<string, unknown>) => write('warn', m, f),
  error: (m: string, f?: Record<string, unknown>) => write('error', m, f),
};
