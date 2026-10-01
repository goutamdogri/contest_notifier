import { readFile, writeFile, chmod, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { google } from 'googleapis';
import { CodeChallengeMethod } from 'google-auth-library';
import type { calendar_v3, tasks_v1 } from 'googleapis';
import { findCredentialsFile, type Config } from '../config.js';
import { log } from '../logger.js';

/**
 * calendar.events covers events.insert / list / patch / delete.
 *
 * calendar.readonly is deliberately NOT requested: it cannot write, and the only
 * reason to add it would be colors.get, which we do not call. Keeping the scope
 * set minimal keeps the consent screen less alarming and avoids the 403 you get
 * when calling colors.get with a calendar.events-only token.
 */
export const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/tasks',
];

export interface AuthClients {
  calendar: calendar_v3.Calendar;
  tasks: tasks_v1.Tasks;
}

interface StoredToken {
  access_token?: string | null;
  refresh_token?: string | null;
  scope?: string;
  token_type?: string;
  expiry_date?: number | null;
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

type OAuthClient = InstanceType<(typeof google.auth)['OAuth2']>;

async function loadClientSecrets(path: string): Promise<{ clientId: string; clientSecret: string }> {
  const parsed = JSON.parse(await readFile(path, 'utf8')) as {
    installed?: { client_id?: string; client_secret?: string };
    web?: { client_id?: string; client_secret?: string };
  };
  const section = parsed.installed ?? parsed.web;
  if (!section?.client_id || !section.client_secret) {
    throw new AuthError(
      `${path} does not look like a Google OAuth client file. Expected an "installed" ` +
        '(Desktop app) section with client_id and client_secret.',
    );
  }
  return { clientId: section.client_id, clientSecret: section.client_secret };
}

async function persistToken(config: Config, token: StoredToken): Promise<void> {
  await mkdir(dirname(config.paths.tokenFile), { recursive: true, mode: 0o700 });
  await writeFile(config.paths.tokenFile, JSON.stringify(token, null, 2), { mode: 0o600 });
  await chmod(config.paths.tokenFile, 0o600);
  log.info('token stored', {
    path: config.paths.tokenFile,
    hasRefreshToken: Boolean(token.refresh_token),
  });
}

/**
 * Runs the installed-app consent flow. Google removed the OOB copy-paste flow,
 * so we bind an ephemeral port on 127.0.0.1 and wait for the redirect.
 */
async function runConsentFlow(client: OAuthClient, config: Config): Promise<StoredToken> {
  // generateCodeVerifierAsync is an instance method that also stashes the verifier
  // on the client for the later code exchange (PKCE, S256).
  const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();

  const redirectUri = await new Promise<string>((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(`http://127.0.0.1:${port}`));
    });
  });

  const url = client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    code_challenge: codeChallenge,
    code_challenge_method: CodeChallengeMethod.S256,
    redirect_uri: redirectUri,
    prompt: 'consent',
  });

  console.log('\nAuthorise this app in your browser:\n');
  console.log(`  ${url}\n`);
  console.log('Waiting for the redirect on 127.0.0.1 (Ctrl+C to cancel)...\n');

  const code = await new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const target = new URL(req.url ?? '/', redirectUri);
      const oauthCode = target.searchParams.get('code');
      const error = target.searchParams.get('error');

      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      if (oauthCode) {
        res.end('<html><body style="font-family:sans-serif;padding:2rem">' +
          '<h2>Authorisation complete.</h2>' +
          '<p>You can close this tab and go back to the terminal.</p></body></html>');
        server.close();
        resolve(oauthCode);
      } else {
        res.end('<html><body>Authorisation failed. Return to the terminal.</body></html>');
        server.close();
        reject(new AuthError(`Consent failed: ${error ?? 'no code returned'}`));
      }
    });
    server.on('error', reject);
    server.listen({ port: Number(new URL(redirectUri).port), host: '127.0.0.1' });
  });

  const { tokens } = await client.getToken({ code, codeVerifier, redirect_uri: redirectUri });
  const stored: StoredToken = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    scope: tokens.scope,
    token_type: 'Bearer',
    expiry_date: tokens.expiry_date,
  };
  // Must be applied to the client, otherwise the API clients built from it in
  // authenticate() have no credentials at all.
  client.setCredentials(stored);
  await persistToken(config, stored);
  return stored;
}

/**
 * Resolves credentials for Calendar and Tasks.
 *
 * A stored refresh token is preferred so the background timer can run unattended.
 * If refreshing fails the grant is considered dead (revoked, or the 7-day expiry
 * that Google applies to "Testing" consent screens), and we fall back to consent.
 */
export async function authenticate(
  config: Config,
  options: { interactive?: boolean } = {},
): Promise<AuthClients> {
  const interactive = options.interactive !== false;

  const credsPath = findCredentialsFile(config.paths);
  if (!credsPath) {
    throw new AuthError(
      'No OAuth client found. Create a Desktop app client in the Google Cloud console ' +
        `and save the JSON as ${config.paths.credentialsFile} (or place client_secret_*.json in the project directory).`,
    );
  }

  const { clientId, clientSecret } = await loadClientSecrets(credsPath);
  const client = new google.auth.OAuth2({ clientId, clientSecret });

  let stored: StoredToken | undefined;
  if (existsSync(config.paths.tokenFile)) {
    try {
      stored = JSON.parse(await readFile(config.paths.tokenFile, 'utf8')) as StoredToken;
    } catch (err) {
      log.warn('stored token is unreadable, discarding it', { error: (err as Error).message });
      await rm(config.paths.tokenFile, { force: true });
    }
  }

  if (stored?.refresh_token) {
    client.setCredentials({ refresh_token: stored.refresh_token });
    try {
      const { token } = await client.getAccessToken();
      if (!token) throw new Error('Google returned no access token');
      client.setCredentials({
        refresh_token: stored.refresh_token,
        access_token: token,
        expiry_date: Date.now() + 55 * 60 * 1000,
      });
      // Persist so the next run starts warm. The refresh token itself is retained,
      // because refresh() issues a new access token without necessarily returning one.
      await persistToken(config, { ...stored, access_token: token });
      log.info('refreshed stored credentials');
    } catch (err) {
      log.warn('stored refresh token rejected, re-consent required', {
        error: (err as Error).message,
      });
      await rm(config.paths.tokenFile, { force: true });
      stored = undefined;
      if (!interactive) {
        throw new AuthError(
          'The stored Google authorisation has expired or been revoked and this run is ' +
            'non-interactive. Run: contest-notifier auth',
        );
      }
    }
  }

  if (!stored?.refresh_token) {
    if (!interactive) {
      throw new AuthError(
        `No usable Google authorisation found. Run: contest-notifier auth  (expected token at ${config.paths.tokenFile})`,
      );
    }
    log.info('starting interactive OAuth consent', { credentialsFile: credsPath });
    await runConsentFlow(client, config);
  }

  return {
    calendar: google.calendar({ version: 'v3', auth: client }),
    tasks: google.tasks({ version: 'v1', auth: client }),
  };
}

/** Cheap round-trip that proves the token can actually reach Calendar. */
export async function checkAuth(clients: AuthClients, calendarId: string): Promise<string> {
  const res = await clients.calendar.events.list({
    calendarId,
    maxResults: 1,
    singleEvents: true,
  });
  return `authorised; calendar "${calendarId}" is reachable (${res.data.items?.length ?? 0} item(s) sampled)`;
}

export async function revokeStoredToken(config: Config): Promise<void> {
  if (!existsSync(config.paths.tokenFile)) {
    console.log('No stored token.');
    return;
  }
  const token = JSON.parse(await readFile(config.paths.tokenFile, 'utf8')) as StoredToken;
  const value = token.access_token ?? token.refresh_token;
  if (value) {
    // revokeCredentials() acts on the client's own credentials, so seed it first.
    // Revoking an access token also revokes its refresh token.
    const oauth = new google.auth.OAuth2();
    oauth.setCredentials({ access_token: value });
    await oauth.revokeCredentials();
    console.log('Revoked with Google and deleted locally.');
  }
  await rm(config.paths.tokenFile, { force: true });
}
