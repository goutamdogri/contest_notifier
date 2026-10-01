import { describe, expect, it } from 'vitest';
import {
  parseAtCoderHtml,
  parseAtCoderDuration,
  parseAtCoderTime,
  normalizeRatedRange,
} from '../src/sources/atcoder.js';
import { DateTime } from 'luxon';

const NOW = DateTime.fromISO('2026-10-01T09:26:00Z', { zone: 'utc' });

function table(id: string, heading: string, rows: string): string {
  return `<div id="${id}"><h3>${heading}</h3><div class="panel"><table><thead><tr>
    <th>Start Time</th><th>Contest Name</th><th>Duration</th><th>Rated Range</th>
  </tr></thead><tbody>${rows}</tbody></table></div></div>`;
}

function row(startIsoJst: string, href: string, spans: string, name: string, duration: string, rated: string): string {
  return `<tr>
    <td class="text-center"><a href='http://www.timeanddate.com/worldclock/fixedtime.html?iso=x' target='blank'><time class='fixtime fixtime-full'>${startIsoJst}</time></a></td>
    <td >${spans} <a href="${href}">${name}</a></td>
    <td class="text-center">${duration}</td>
    <td class="text-center">${rated}</td>
  </tr>`;
}

// The exact markup shape AtCoder serves: decorative glyph spans whose *text nodes*
// hold Ⓐ/Ⓗ and ◉, plus a rating-tier CSS class.
const ABC_SPANS = `<span aria-hidden='true' data-toggle='tooltip' data-placement='top' title="Algorithm">Ⓐ</span><span class="user-blue">◉</span>`;
const AHC_SPANS = `<span aria-hidden='true' data-toggle='tooltip' data-placement='top' title="Heuristic">Ⓗ</span><span class="">◉</span>`;

const FIXTURE = `
<html><body>
${table(
  'contest-table-action',
  'Ongoing Contests',
  row('2026-09-25 19:10:00+0900', '/contests/ahc072', AHC_SPANS, 'ALGO ARTIS Programming Contest 2026 September（AtCoder Heuristic Contest 072）', '239:50', 'All'),
)}
${table(
  'contest-table-permanent',
  'Permanent Contests',
  row('2020-01-01 00:00:00+0900', '/contests/practice2', ABC_SPANS, 'practice2', '365:00', 'All'),
)}
${table(
  'contest-table-upcoming',
  'Upcoming Contests',
  [
    row('2026-10-03 21:00:00+0900', '/contests/abc478', ABC_SPANS, 'AtCoder Beginner Contest 478', '01:40', ' - 1999'),
    row('2026-10-04 21:00:00+0900', '/contests/arc231', ABC_SPANS, 'AtCoder Regular Contest 231', '02:00', '1200 - 2799'),
    row('2026-10-10 21:00:00+0900', '/contests/arc232', ABC_SPANS, 'AtCoder Regular Contest++ 232', '02:30', '1600 - 2999'),
    row('2026-10-12 13:00:00+0900', '/contests/aalc001', ABC_SPANS, 'AAL Contest 001: Let&#39;s use segtree!', '05:00', '-'),
    row('2026-10-30 19:00:00+0900', '/contests/ahc074', AHC_SPANS, 'HACK TO THE FUTURE 2027（AtCoder Heuristic Contest 074）', '240:00', 'All'),
  ].join('\n'),
)}
${table(
  'contest-table-daily',
  'Daily Contests',
  row('2026-10-01 19:00:00+0900', '/contests/adt_all_20261001_1', ABC_SPANS, 'AtCoder Daily Training', '00:30', '-'),
)}
${table(
  'contest-table-recent',
  'Recent Contests',
  row('2026-09-26 21:00:00+0900', '/contests/abc477', ABC_SPANS, 'AtCoder Beginner Contest 477', '01:40', ' - 1999'),
)}
</body></html>`;

describe('parseAtCoderTime', () => {
  it('reads the JST wall clock correctly', () => {
    // 21:00 JST == 12:00 UTC == 17:30 IST. Getting this wrong by 9h was a real bug.
    const parsed = parseAtCoderTime('2026-10-03 21:00:00+0900');
    expect(parsed?.toUTC().toISO()).toBe('2026-10-03T12:00:00.000Z');
    expect(parsed?.setZone('Asia/Kolkata').toFormat('HH:mm')).toBe('17:30');
  });

  it('rejects strings with a colon-bearing offset, which Luxon fromISO would accept silently', () => {
    expect(parseAtCoderTime('2026-10-03 21:00:00+09:00')).toBeUndefined();
  });

  it('rejects malformed input', () => {
    expect(parseAtCoderTime('')).toBeUndefined();
    expect(parseAtCoderTime('not a time')).toBeUndefined();
    expect(parseAtCoderTime('2026-10-03 21:00:00')).toBeUndefined();
  });
});

describe('parseAtCoderDuration', () => {
  it('parses zero-padded HH:MM', () => {
    expect(parseAtCoderDuration('01:40')).toBe(100);
    expect(parseAtCoderDuration('05:00')).toBe(300);
  });

  it('handles marathon durations that exceed 24 hours and are not zero-padded', () => {
    expect(parseAtCoderDuration('240:00')).toBe(14400);
    expect(parseAtCoderDuration('239:50')).toBe(14390);
  });

  it('rejects malformed durations', () => {
    expect(parseAtCoderDuration('')).toBeUndefined();
    expect(parseAtCoderDuration('1:2:3')).toBeUndefined();
    expect(parseAtCoderDuration('01:75')).toBeUndefined();
    expect(parseAtCoderDuration('abc')).toBeUndefined();
  });
});

describe('normalizeRatedRange', () => {
  it('renders an open lower bound readably', () => {
    expect(normalizeRatedRange(' - 1999')).toBe('≤ 1999');
  });

  it('normalises an en dash between bounds', () => {
    expect(normalizeRatedRange('1200 - 2799')).toBe('1200 – 2799');
  });

  it('treats the dash-only cell as absent', () => {
    expect(normalizeRatedRange('-')).toBeUndefined();
    expect(normalizeRatedRange('  ')).toBeUndefined();
  });

  it('passes through "All"', () => {
    expect(normalizeRatedRange('All')).toBe('All');
  });
});

describe('parseAtCoderHtml', () => {
  const contests = parseAtCoderHtml(FIXTURE, NOW);
  const byKey = new Map(contests.map((c) => [c.key, c]));

  it('only reads the upcoming and ongoing tables', () => {
    // permanent / daily / recent contests must never be tracked.
    expect(byKey.has('atcoder:practice2')).toBe(false);
    expect(byKey.has('atcoder:adt_all_20261001_1')).toBe(false);
    expect(byKey.has('atcoder:abc477')).toBe(false);
  });

  it('includes the ongoing contest and flags it as in progress', () => {
    const ongoing = byKey.get('atcoder:ahc072');
    expect(ongoing).toBeDefined();
    expect(ongoing?.inProgress).toBe(true);
  });

  it('strips the decorative glyph spans from the contest name', () => {
    // Regression: reading cell.text() yielded "Ⓐ◉ AtCoder Beginner Contest 478".
    expect(byKey.get('atcoder:abc478')?.name).toBe('AtCoder Beginner Contest 478');
  });

  it('handles full-width parentheses and non-ASCII names', () => {
    expect(byKey.get('atcoder:ahc074')?.name).toBe(
      'HACK TO THE FUTURE 2027（AtCoder Heuristic Contest 074）',
    );
  });

  it('converts JST start times to the correct instant', () => {
    expect(byKey.get('atcoder:abc478')?.start.toUTC().toISO()).toBe('2026-10-03T12:00:00.000Z');
    expect(byKey.get('atcoder:aalc001')?.start.toUTC().toISO()).toBe('2026-10-12T04:00:00.000Z');
  });

  it('computes the end from the duration cell, including marathons', () => {
    const abc = byKey.get('atcoder:abc478');
    expect(abc?.end.toUTC().toISO()).toBe('2026-10-03T13:40:00.000Z'); // 21:00 + 100min
    const marathon = byKey.get('atcoder:ahc074');
    expect(marathon?.end.diff(marathon!.start, 'hours').hours).toBe(240);
  });

  it('builds the contest URL from the slug', () => {
    expect(byKey.get('atcoder:arc231')?.url).toBe('https://atcoder.jp/contests/arc231');
  });

  it('carries the normalised rated range', () => {
    expect(byKey.get('atcoder:abc478')?.ratedRange).toBe('≤ 1999');
    expect(byKey.get('atcoder:arc231')?.ratedRange).toBe('1200 – 2799');
    expect(byKey.get('atcoder:aalc001')?.ratedRange).toBeUndefined();
    expect(byKey.get('atcoder:ahc074')?.ratedRange).toBe('All');
  });

  it('decodes HTML entities in names', () => {
    expect(byKey.get('atcoder:aalc001')?.name).toBe("AAL Contest 001: Let's use segtree!");
  });

  it('returns an empty list rather than throwing when the page shape changes', () => {
    expect(parseAtCoderHtml('<html><body>maintenance</body></html>', NOW)).toEqual([]);
  });

  it('skips contests that have already finished', () => {
    const past = parseAtCoderHtml(
      `<html><body>${table(
        'contest-table-upcoming',
        'Upcoming Contests',
        row('2020-01-01 00:00:00+0900', '/contests/old', ABC_SPANS, 'Old Contest', '02:00', '-'),
      )}</body></html>`,
      NOW,
    );
    expect(past).toEqual([]);
  });
});
