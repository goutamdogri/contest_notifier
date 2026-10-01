import * as cheerio from 'cheerio';
import type { CheerioAPI, Cheerio } from 'cheerio';
import type { AnyNode } from 'domhandler';
import { DateTime } from 'luxon';
import { fetchText } from '../http.js';
import type { Config } from '../config.js';
import { makeContestKey, type Contest } from '../models.js';

const ENDPOINT = 'https://atcoder.jp/contests/';

/** AtCoder publishes JST year-round with an explicit +0900 offset in the markup. */
const ATCODER_TIME_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\+0900$/;

/** JST has no DST, so a fixed IANA zone reproduces the +0900 stamp exactly. */
const ATCODER_ZONE = 'Asia/Tokyo';

/**
 * AtCoder renders its start times as "2026-10-03 21:00:00+0900". That +0900 is
 * NOT valid ISO 8601 (which requires +09:00), so DateTime.fromISO rejects the
 * string outright. We match the known shape and read the wall clock in JST.
 */
export function parseAtCoderTime(raw: string): DateTime | undefined {
  const match = ATCODER_TIME_RE.exec(raw.trim());
  if (!match) return undefined;
  const [, y, mo, d, h, mi, s] = match;
  const parsed = DateTime.fromObject(
    {
      year: Number(y),
      month: Number(mo),
      day: Number(d),
      hour: Number(h),
      minute: Number(mi),
      second: Number(s),
    },
    { zone: ATCODER_ZONE },
  );
  return parsed.isValid ? parsed.toUTC() : undefined;
}

/**
 * Parses the `HH:MM` duration cell. AtCoder does not zero-pad and happily exceeds
 * 24 hours for marathons (a 10-day AHC shows as "240:00"), so the hour component
 * must be treated as a plain integer count of hours, not a clock field.
 */
export function parseAtCoderDuration(raw: string): number | undefined {
  const text = raw.trim();
  const match = /^(\d+):(\d{1,2})$/.exec(text);
  if (!match) return undefined;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes) || minutes > 59) return undefined;
  return hours * 60 + minutes;
}

/**
 * The rated-range cell renders as "1200 - 2799", " - 1999" (open lower bound),
 * "All", or "-". Normalise the open-bound and dash-only forms into something
 * readable in a calendar description.
 */
export function normalizeRatedRange(raw: string): string | undefined {
  const text = raw.replace(/\s+/g, ' ').trim();
  if (!text || text === '-') return undefined;
  if (text === 'All') return 'All';
  const openLower = /^-\s*(\d+)$/.exec(text);
  if (openLower) return `≤ ${openLower[1]}`;
  return text.replace(/\s+-\s+/g, ' – ');
}

type Section = 'ongoing' | 'upcoming';

/**
 * The contest-name cell is prefixed with decorative spans whose *text nodes*
 * hold a category glyph (Ⓐ / Ⓗ) and a rated marker (◉), plus a rating-tier CSS
 * class such as `user-blue`. Stripping tags is not enough because the glyphs are
 * real characters, so we read the text of the contest link itself, which contains
 * only the name.
 */
function extractName($: CheerioAPI, nameCell: Cheerio<AnyNode>): string | undefined {
  const link = nameCell
    .find('a')
    .filter((_i, el) => /^\/contests\/[^/]+\/?$/.test($(el).attr('href') ?? ''))
    .first();
  const text = (link.length > 0 ? link.text() : nameCell.text()).replace(/\s+/g, ' ').trim();
  return text.length > 0 ? text : undefined;
}

function parseTable($: CheerioAPI, tableId: string, section: Section, now: DateTime): Contest[] {
  const contests: Contest[] = [];
  const table = $(`#${tableId}`);
  if (table.length === 0) return contests;

  table.find('tbody tr').each((_i, row) => {
    const cells = $(row).find('td');
    if (cells.length < 3) return;

    const timeCell = cells.eq(0);
    const nameCell = cells.eq(1);
    const durationCell = cells.eq(2);
    const ratedCell = cells.eq(3);

    // The <time> text node holds the server-rendered JST stamp. The wrapper <a>
    // points at timeanddate.com and the element carries a JS class that rewrites
    // it to the viewer's local zone, so the text node is the source of truth.
    const timeText = timeCell.find('time').first().text();
    const start = parseAtCoderTime(timeText);
    if (!start) return;

    const href = nameCell.find('a').attr('href');
    if (!href) return;
    const slug = href.replace(/^\/contests\//, '').replace(/\/$/, '');
    if (!slug) return;

    const name = extractName($, nameCell);
    if (!name) return;

    const durationMinutes = parseAtCoderDuration(durationCell.text());
    if (durationMinutes === undefined) return;

    const warnings: string[] = [];
    const end = start.plus({ minutes: durationMinutes });
    if (end <= now) return;

    const ratedRange = normalizeRatedRange(ratedCell.text());

    const contest: Contest = {
      platform: 'atcoder',
      platformId: slug,
      key: makeContestKey('atcoder', slug),
      name,
      start,
      end,
      url: `https://atcoder.jp/contests/${slug}`,
      inProgress: section === 'ongoing',
      warnings,
    };
    if (ratedRange) contest.ratedRange = ratedRange;
    contests.push(contest);
  });

  return contests;
}

/**
 * AtCoder's `?format=json` route was removed site-wide (every JSON path now
 * returns HTML) and there is no iCalendar feed, so the contests index must be
 * scraped. The `kenkoooo.com` community mirror looks tempting but is useless
 * here: it contains only already-run contests and zero future ones.
 */
export function parseAtCoderHtml(html: string, now: DateTime): Contest[] {
  const $ = cheerio.load(html);

  const upcoming = parseTable($, 'contest-table-upcoming', 'upcoming', now);
  const ongoing = parseTable($, 'contest-table-action', 'ongoing', now);

  // Ongoing entries also appear once they roll into the recent table, so dedupe.
  const byKey = new Map<string, Contest>();
  for (const contest of [...ongoing, ...upcoming]) byKey.set(contest.key, contest);
  return [...byKey.values()];
}

export async function fetchAtCoder(config: Config, now: DateTime): Promise<Contest[]> {
  const html = await fetchText(ENDPOINT, { userAgent: config.userAgent });
  return parseAtCoderHtml(html, now);
}
