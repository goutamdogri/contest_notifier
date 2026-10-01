import { setTimeout as sleep } from 'node:timers/promises';

export interface FetchOptions {
  userAgent: string;
  timeoutMs?: number;
  retries?: number;
  headers?: Record<string, string>;
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/**
 * fetch with a descriptive User-Agent, a hard timeout and exponential backoff.
 * We never scrape Codeforces HTML (it 403s generic clients behind Cloudflare)
 * and we stay well inside the documented 1 request / 2 seconds API budget.
 */
export async function fetchText(url: string, options: FetchOptions): Promise<string> {
  const { userAgent, timeoutMs = 20_000, retries = 3, headers = {} } = options;

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(Math.min(2 ** attempt * 500, 8_000));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        redirect: 'follow',
        headers: {
          'user-agent': userAgent,
          accept: '*/*',
          'accept-language': 'en',
          ...headers,
        },
      });
      if (!res.ok) {
        // 4xx other than 429 will not improve on retry.
        const permanent = res.status >= 400 && res.status < 500 && res.status !== 429;
        throw new HttpError(`HTTP ${res.status} ${res.statusText}`, res.status, url);
      }
      return await res.text();
    } catch (err) {
      lastError = err;
      if (err instanceof HttpError && err.status >= 400 && err.status < 500 && err.status !== 429) {
        break;
      }
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error(
    `GET ${url} failed after ${retries + 1} attempt(s): ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
    { cause: lastError },
  );
}

/**
 * POST a JSON body. GraphQL endpoints (LeetCode) reject GET, so this is separate
 * from fetchJson. Retry and timeout behaviour match fetchText.
 */
export async function postJson<T = unknown>(
  url: string,
  body: unknown,
  options: FetchOptions,
): Promise<T> {
  const { userAgent, timeoutMs = 20_000, retries = 3, headers = {} } = options;

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(Math.min(2 ** attempt * 500, 8_000));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        signal: controller.signal,
        redirect: 'follow',
        headers: {
          'user-agent': userAgent,
          // content-type is mandatory for a GraphQL POST: without it LeetCode's edge
          // answers HTTP 499 ("client closed request") and never parses the query.
          'content-type': 'application/json',
          'accept-language': 'en',
          accept: 'application/json',
          ...headers,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        throw new HttpError(`HTTP ${res.status} ${res.statusText}`, res.status, url);
      }
      const text = await res.text();
      try {
        // Returned even on HTTP 400: GraphQL reports schema errors in the body.
        return JSON.parse(text) as T;
      } catch {
        const preview = text.slice(0, 200).replace(/\s+/g, ' ');
        throw new Error(`Response from ${url} was not valid JSON. First bytes: ${preview}`, {
          cause: lastError,
        });
      }
    } catch (err) {
      lastError = err;
      if (err instanceof HttpError && err.status >= 400 && err.status < 500 && err.status !== 429) {
        // A 4xx body may still carry a usable GraphQL payload, so this is not fatal
        // here; parseLeetCodePayload surfaces any errors array it contains.
        const text = await (err as { body?: string }).body;
        if (typeof text === 'string') {
          try {
            return JSON.parse(text) as T;
          } catch {
            /* fall through to retry */
          }
        }
        break;
      }
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error(
    `POST ${url} failed after ${retries + 1} attempt(s): ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
    { cause: lastError },
  );
}

export async function fetchJson<T = unknown>(url: string, options: FetchOptions): Promise<T> {
  const text = await fetchText(url, { ...options, headers: { accept: 'application/json', ...options.headers } });
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    const preview = text.slice(0, 200).replace(/\s+/g, ' ');
    throw new Error(`Response from ${url} was not valid JSON. First bytes: ${preview}`, {
      cause: err,
    });
  }
}
