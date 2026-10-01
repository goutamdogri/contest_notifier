import type { tasks_v1 } from 'googleapis';
import { createHash } from 'node:crypto';
import { DateTime } from 'luxon';
import type { Config } from '../config.js';
import type { Contest } from '../models.js';
import { contestDurationMinutes } from '../models.js';
import { log } from '../logger.js';

const PLATFORM_LABEL: Record<Contest['platform'], string> = {
  codeforces: 'Codeforces',
  atcoder: 'AtCoder',
  codechef: 'CodeChef',
};

/**
 * Machine-readable dedup marker. The Tasks API has no labels and no extended
 * properties, so the only writable fields are title/notes/status/due/etag. Notes
 * is the right carrier: multiline-safe, 8192 chars, and not rendered in the task row.
 */
const KEY_PATTERN = /^contest-notifier-key:\s*(\S+)\s*$/m;

export function buildTaskTitle(contest: Contest): string {
  return `Register for ${PLATFORM_LABEL[contest.platform]}: ${contest.name}`;
}

export function buildTaskNotes(contest: Contest, config: Config): string {
  const zone = config.timezone;
  const startLocal = contest.start.setZone(zone);
  const lines = [
    `contest-notifier-key: ${contest.key}`,
    '',
    `Platform: ${PLATFORM_LABEL[contest.platform]}`,
    `Starts: ${startLocal.toFormat('ccc dd LLL yyyy, HH:mm')} ${zone}`,
    `Duration: ${contestDurationMinutes(contest)} min`,
    '',
    contest.url,
  ];
  return lines.join('\n');
}

/**
 * Builds the request body for tasks.insert.
 *
 * `due` is effectively date-only: Google discards the time portion, so we send the
 * contest date at 00:00 UTC. This makes the task appear on the Google Tasks
 * calendar grid for the day of the contest. It cannot be used to trigger a
 * notification at a chosen time, which is why all four timed notifications live on
 * the Calendar event instead.
 */
export function buildTaskRequest(contest: Contest, config: Config): tasks_v1.Schema$Task {
  const dueDate = contest.start.setZone('utc').startOf('day');
  return {
    title: buildTaskTitle(contest),
    notes: buildTaskNotes(contest, config),
    status: 'needsAction',
    due: dueDate.toISO({ suppressMilliseconds: true }),
  };
}

export function parseKeyFromNotes(notes: string | null | undefined): string | undefined {
  if (!notes) return undefined;
  const match = KEY_PATTERN.exec(notes);
  return match?.[1];
}

/**
 * Finds (or creates) the dedicated task list. A separate list is the most robust
 * dedup boundary: membership itself identifies our tasks, so nothing can collide
 * with the user's real tasks and completed/hidden rows stay isolated.
 */
export async function ensureTaskList(
  clients: { tasks: tasks_v1.Tasks },
  config: Config,
): Promise<string> {
  const name = config.taskListName;
  const res = await clients.tasks.tasklists.list({ maxResults: 1000 });
  const existing = res.data.items?.find((list) => list.title === name);
  if (existing?.id) {
    log.debug('reusing task list', { id: existing.id, title: name });
    return existing.id;
  }

  const created = await clients.tasks.tasklists.insert({ requestBody: { title: name } });
  const id = created.data.id;
  if (!id) throw new Error('Task list was created but Google returned no id');
  log.info('created task list', { id, title: name });
  return id;
}

/**
 * Loads contest key -> task id for the list.
 *
 * showCompleted and showHidden are passed explicitly because the official docs
 * contradict each other on their defaults, and tasks.clear sets hidden=true, which
 * would otherwise make a finished task invisible and cause us to recreate it.
 */
export async function indexTasks(
  clients: { tasks: tasks_v1.Tasks },
  taskListId: string,
): Promise<Map<string, string>> {
  const index = new Map<string, string>();
  let pageToken: string | undefined;

  do {
    const res = await clients.tasks.tasks.list({
      tasklist: taskListId,
      maxResults: 100,
      showCompleted: true,
      showHidden: true,
      ...(pageToken === undefined ? {} : { pageToken }),
    });

    for (const task of res.data.items ?? []) {
      const key = parseKeyFromNotes(task.notes);
      if (key && task.id) index.set(key, task.id);
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  return index;
}

export interface TaskSyncResult {
  created: string[];
  unchanged: string[];
  failed: Array<{ key: string; error: string }>;
}

/**
 * Hash of the parts of a task we manage. Used to decide whether a PATCH is needed;
 * without it every run would write 11 unchanged tasks and inflate their revision
 * history for no reason.
 */
export function taskContentHash(contest: Contest, config: Config): string {
  const body = [
    buildTaskTitle(contest),
    buildTaskNotes(contest, config),
    contest.start.setZone('utc').startOf('day').toISO(),
  ].join('\n');
  return createHash('sha256').update(body).digest('hex').slice(0, 32);
}

export interface TaskSyncOutcome {
  outcome: 'created' | 'updated' | 'unchanged';
  taskId: string;
}

export async function syncContestTask(
  clients: { tasks: tasks_v1.Tasks },
  contest: Contest,
  config: Config,
  taskListId: string,
  existing: { taskId: string | undefined; hash: string | undefined },
): Promise<TaskSyncOutcome> {
  const hash = taskContentHash(contest, config);

  if (existing.taskId) {
    if (existing.hash === hash) {
      log.debug('task unchanged', { key: contest.key, taskId: existing.taskId });
      return { outcome: 'unchanged', taskId: existing.taskId };
    }
    await clients.tasks.tasks.patch({
      tasklist: taskListId,
      task: existing.taskId,
      requestBody: buildTaskRequest(contest, config),
    });
    log.info('updated task', { key: contest.key, taskId: existing.taskId });
    return { outcome: 'updated', taskId: existing.taskId };
  }

  const created = await clients.tasks.tasks.insert({
    tasklist: taskListId,
    requestBody: buildTaskRequest(contest, config),
  });
  if (!created.data.id) throw new Error('Task was created but Google returned no id');
  log.info('created task', { key: contest.key, taskId: created.data.id });
  return { outcome: 'created', taskId: created.data.id };
}

/** Deletes tasks for contests that are over, keeping the list from growing forever. */
export async function pruneCompletedTasks(
  clients: { tasks: tasks_v1.Tasks },
  taskListId: string,
  keepKeys: Set<string>,
): Promise<number> {
  const index = await indexTasks(clients, taskListId);
  let removed = 0;

  for (const [key, taskId] of index) {
    if (keepKeys.has(key)) continue;
    await clients.tasks.tasks.delete({ tasklist: taskListId, task: taskId });
    removed++;
  }

  if (removed > 0) log.info('pruned tasks for contests no longer tracked', { count: removed });
  return removed;
}

export function taskDueDateUtc(contest: Contest): DateTime {
  return contest.start.setZone('utc').startOf('day');
}
