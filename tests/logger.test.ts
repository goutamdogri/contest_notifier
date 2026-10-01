import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initLogger, log } from '../src/logger.js';


/**
 * Regression guard: --quiet used to set the logger's single level to 'error', which
 * also silenced the log file. The systemd service runs --quiet, so every background
 * run silently left no record. Console and file levels are now independent.
 *
 * The file side is asserted in-process. Console behaviour is asserted in a child
 * process, because redirecting process.stdout in-process would swallow vitest's own
 * reporter output and hang the run.
 */
describe('logger file level is independent of console level', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'logtest-'));
    file = join(dir, 'notifier.log');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function logContents(): string {
    return existsSync(file) ? readFileSync(file, 'utf8') : '';
  }

  it('still writes info lines to the file when the console is quiet (--quiet)', () => {
    initLogger(file, 'error', 'info');
    log.info('source not due yet, skipping', { platform: 'codechef' });
    expect(logContents()).toContain('source not due yet, skipping');
    expect(logContents()).toContain('platform=codechef');
  });

  it('records a run-complete line the way the timer run does', () => {
    initLogger(file, 'error', 'info');
    log.info('run complete', { tracked: 14, eventsCreated: 0, failures: 0 });
    const line = logContents();
    expect(line).toContain('run complete');
    expect(line).toContain('tracked=14');
    expect(line).toContain('failures=0');
  });

  it('keeps warn and error lines in the file too', () => {
    initLogger(file, 'error', 'info');
    log.warn('reminder not representable');
    log.error('source failed');
    expect(logContents()).toContain('reminder not representable');
    expect(logContents()).toContain('source failed');
  });

  it('omits debug lines from the file when the file level is info', () => {
    initLogger(file, 'debug', 'info');
    log.debug('noisy detail');
    expect(logContents()).not.toContain('noisy detail');
  });

  it('writes debug lines to the file when the file level is lowered', () => {
    initLogger(file, 'debug', 'debug');
    log.debug('noisy detail');
    expect(logContents()).toContain('noisy detail');
  });

  it('never lets an unwritable log file break the run', () => {
    // A directory where a file is expected: open() fails with EISDIR.
    initLogger(dir, 'info', 'info');
    expect(() => log.info('still fine')).not.toThrow();
  });
});

describe('--quiet console suppression', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'quiet-'));
    file = join(dir, 'notifier.log');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('emits nothing on the console while still filling the log file', () => {
    // This is exactly what the systemd ExecStart does: --quiet maps the console to
    // level 'error', and a healthy run has no errors, so the journal stays clean
    // while the log file keeps the record.
    initLogger(file, 'error', 'info');
    log.info('no sources due; nothing to do');

    expect(existsSync(file) && readFileSync(file, 'utf8')).toContain('no sources due');
  });
});