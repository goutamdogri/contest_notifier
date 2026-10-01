#!/usr/bin/env node
import { DateTime } from 'luxon';
import { loadConfig, DEFAULT_CONFIG, type Config } from './config.js';
import { initLogger, log } from './logger.js';
import { Store } from './db.js';
import { run, type RunSummary } from './run.js';
import { authenticate, checkAuth, revokeStoredToken } from './google/auth.js';
import { deterministicEventId, discoverExistingEvents, isNotFound } from './google/calendar.js';

interface Args {
  command: string;
  configPath?: string;
  verbose: boolean;
  quiet: boolean;
  force: boolean;
  dryRun: boolean;
  bodies: boolean;
  interactive: boolean;
  resync: boolean;
}

function parseArgs(argv: string[]): Args {
  const rest = argv.slice(2);
  const command = rest[0] && !rest[0].startsWith('-') ? rest[0] : '';
  return {
    command,
    configPath: rest.find((a) => a.startsWith('--config='))?.slice('--config='.length),
    verbose: rest.includes('--verbose') || rest.includes('-v'),
    quiet: rest.includes('--quiet') || rest.includes('-q'),
    force: rest.includes('--force'),
    dryRun: rest.includes('--dry-run'),
    bodies: rest.includes('--bodies'),
    interactive: !rest.includes('--non-interactive'),
    resync: rest.includes('--resync'),
  };
}

const USAGE = `
contest-notifier - sync upcoming coding contests to Google Calendar and Google Tasks

Usage: contest-notifier <command> [options]

Commands:
  run              Fetch contests and create/update Calendar events and Tasks.
  fetch            List contests that would be synced. Never writes anything.
  dry-run          Same as "run --dry-run": show the plan without contacting Google.
  auth             Authorise against Google (opens a browser, stores a token).
  status           Show config, stored state, and last fetch times.
  resync           Rebuild local state from Google, then sync.
  probe-colors     Create one short event per Calendar colour id so you can
                   visually confirm which id is Blueberry. Deletes them after.
  revoke           Revoke the stored Google authorisation and delete the token.

Options:
  --config=PATH    Use an alternate config file.
  --dry-run        Do not write to Google. Implied by "fetch" and "dry-run".
  --bodies         With --dry-run, print the full events.insert request bodies.
  --force          Ignore per-source poll intervals and fetch everything.
  --verbose, -v    Debug logging and per-contest reminder detail.
  --quiet, -q      Errors only.
  --non-interactive  Never prompt for authorisation; fail instead.
  --resync         Reconcile with Google before syncing.

Notes:
  * All four notification times (1 day before, that day at 06:00 local,
    2 hours before, 5 minutes before) are Calendar reminders, because the
    Google Tasks API has no reminders field at all and Tasks "due" is date-only.
  * Calendar reminders fire from Google's servers, so they still reach you when
    this machine is asleep. This tool only needs to be awake to create the event.
`;

function printSummary(summary: RunSummary): void {
  console.log('');
  console.log(`Fetched:        ${summary.fetched} contest(s) from the platforms`);
  console.log(`In horizon:     ${summary.tracked}`);
  console.log(`Events created: ${summary.eventsCreated.length}`);
  console.log(`Events updated: ${summary.eventsUpdated.length}`);
  console.log(`Events current: ${summary.eventsUnchanged.length}`);
  console.log(`Tasks created:  ${summary.tasksCreated.length}`);
  if (summary.skippedSources.length > 0) {
    console.log(`Skipped (not due): ${summary.skippedSources.join(', ')}`);
  }

  if (summary.failures.length > 0) {
    console.log('');
    console.log('Problems:');
    for (const failure of summary.failures) {
      console.log(`  [${failure.scope}] ${failure.error}`);
    }
  }
}

async function cmdStatus(config: Config): Promise<number> {
  const store = new Store(config.paths.dbFile);
  try {
    console.log('Configuration');
    console.log(`  timezone        ${config.timezone}`);
    console.log(`  horizonDays     ${config.horizonDays}`);
    console.log(`  calendarId      ${config.calendarId}`);
    console.log(`  calendarColorId ${config.calendarColorId} (Blueberry)`);
    console.log(`  taskListName    ${config.taskListName}`);
    console.log(`  reminderMethod  ${config.reminders.method}`);
    console.log(`  anchorHour      ${config.reminders.sixAmLocalHour}:00 ${config.timezone}`);
    console.log('');
    console.log('Paths');
    console.log(`  config   ${config.paths.configDir}`);
    console.log(`  token    ${config.paths.tokenFile}`);
    console.log(`  database ${config.paths.dbFile}`);
    console.log(`  log      ${config.paths.logFile}`);
    console.log('');

    console.log('Sources');
    for (const [platform, source] of Object.entries(config.sources)) {
      const state = store.getSourceState(platform);
      const last = state.last_fetch_at ? DateTime.fromISO(state.last_fetch_at).toRelative() : 'never';
      console.log(
        `  ${platform.padEnd(11)} enabled=${String(source.enabled).padEnd(5)} ` +
          `every ${String(source.pollIntervalMinutes).padStart(4)}m  last fetch: ${last}` +
          (state.last_error ? `  last error: ${state.last_error}` : ''),
      );
    }
    console.log('');

    const contests = store.allContests().sort((a, b) => a.start_utc.localeCompare(b.start_utc));
    console.log(`Tracked contests (${contests.length})`);
    for (const contest of contests) {
      const local = DateTime.fromISO(contest.start_utc).setZone(config.timezone);
      console.log(
        `  ${contest.key.padEnd(26)} ${local.toFormat('LLL dd HH:mm')}  ` +
          `event=${contest.calendar_event_id ? 'yes' : 'no '} task=${contest.task_id ? 'yes' : 'no '}  ` +
          contest.name,
      );
    }
    return 0;
  } finally {
    store.close();
  }
}

async function cmdProbeColors(config: Config): Promise<number> {
  console.log('Creating one event per colour id (1-11). Check your calendar,');
  console.log('note which one is Blueberry, then run: rm the probe events.');
  console.log('');
  const clients = await authenticate(config, { interactive: true });
  const created: string[] = [];

  for (let id = 1; id <= 11; id++) {
    const now = DateTime.now().setZone(config.timezone);
    const event = await clients.calendar.events.insert({
      calendarId: config.calendarId,
      requestBody: {
        id: `cnprobe${String(id).padStart(3, '0')}xxxxxxxxxxxxxxxxxxxx`,
        summary: `Colour probe ${id}`,
        description: 'Delete me. Shows the rendered colour for this colorId.',
        start: { dateTime: now.toISO({ suppressMilliseconds: true }), timeZone: config.timezone },
        end: { dateTime: now.plus({ minutes: 10 }).toISO({ suppressMilliseconds: true }), timeZone: config.timezone },
        colorId: String(id),
        reminders: { useDefault: false, overrides: [] },
      },
    });
    created.push(event.data.id ?? `cnprobe${id}`);
    console.log(`  created colourId "${id}" -> ${event.data.htmlLink ?? 'ok'}`);
  }

  console.log('');
  console.log('Probe events:', created.join(' '));
  console.log('If Blueberry is not id 9, set "calendarColorId" in your config file.');
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const config = loadConfig(args.configPath);
  // Console verbosity follows the flags; the log file always records from info up,
  // so an unattended --quiet run still leaves an audit trail.
  initLogger(config.paths.logFile, args.verbose ? 'debug' : args.quiet ? 'error' : 'info', 'info');

  switch (args.command) {
    case 'run': {
      const summary = await run(config, {
        force: args.force,
        dryRun: args.dryRun,
        interactive: args.interactive,
        resync: args.resync,
        showBodies: args.bodies,
      });
      if (!args.quiet) printSummary(summary);
      return summary.failures.length > 0 ? 1 : 0;
    }

    case 'dry-run': {
      await run(config, {
        force: args.force,
        dryRun: true,
        showBodies: args.bodies,
      });
      return 0;
    }

    case 'fetch':
    case 'list': {
      const summary = await run(config, { force: true, dryRun: true });
      return summary.failures.length > 0 ? 1 : 0;
    }

    case 'auth': {
      const clients = await authenticate(config, { interactive: true });
      const status = await checkAuth(clients, config.calendarId);
      console.log(`\nOK - ${status}`);
      console.log(`Token stored at ${config.paths.tokenFile} (mode 0600).`);
      return 0;
    }

    case 'status':
      return cmdStatus(config);

    case 'probe-colors':
      return cmdProbeColors(config);

    case 'revoke':
      await revokeStoredToken(config);
      return 0;

    case 'defaults': {
      console.log(JSON.stringify(DEFAULT_CONFIG, null, 2));
      return 0;
    }

    case 'help':
    case '--help':
    case '-h':
    case '':
      console.log(USAGE);
      return 0;

    default:
      console.error(`Unknown command: ${args.command}`);
      console.log(USAGE);
      return 2;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  (import.meta.url === `file://${process.argv[1]}` || import.meta.url.endsWith('/cli.ts'));

if (invokedDirectly) {
  main(process.argv)
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      log.error('fatal', { error: err instanceof Error ? err.message : String(err) });
      if (process.env.DEBUG) console.error(err);
      process.exitCode = 1;
    });
}
