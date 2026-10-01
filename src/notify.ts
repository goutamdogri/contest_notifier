import { spawn } from 'node:child_process';
import { log } from './logger.js';

/**
 * Fires a desktop notification via notify-send. Best effort: if the tool is not
 * running inside a graphical session, or notify-send is missing, we log and move on.
 * Note this is only for "we found something new" feedback. The four contest
 * reminders themselves are Google Calendar reminders and fire regardless of
 * whether this machine is awake.
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
