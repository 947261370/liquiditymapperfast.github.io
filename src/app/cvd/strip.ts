import { type SizesAnswer, type SizesWindow } from '../../shared/footprint.ts';
import { SIZE_FLOOR_USD, linesToAsk, overFromBoxes, sizeText } from '../sizes.ts';
import type { FlowBook } from '../flow-book.ts';
import type { InfoLine } from '../infobox.ts';
import type { Scope } from '../store.ts';
import { t } from '../i18n.ts';
import { RANK_MS, type CvdSettings } from './settings.ts';
import { plainUsd, signedUsd, windowName } from './text.ts';
import { scaledUsd, sizeScale } from '../coin.ts';

/**
 * The strip of dot rows above the exchanges. Everything it says, worked out here without a canvas: four rows of taker buys against sells over
 * the last 1, 5, 15 and 60 minutes (from the flow book, over the instruments of the ALL VENUES row, so the two agree), and one row per band of
 * trade sizes over the column's ranking window (from the footprint recorder's per-minute statistics, which is the only place the sizes are kept).
 * Each row says which share of its window was recorded, because the recorder is not always running and a row that covers 47 of its 60 minutes
 * must not look like one that covers all of them.
 */

/** The windows of the taker-flow rows, in minutes. */
export const PULSE_MINUTES: readonly number[] = [1, 5, 15, 60];
const PULSE_LABELS: Readonly<Record<number, string>> = { 1: '1m', 5: '5m', 15: '15m', 60: '1h' };

/** The windows one sizes question asks for: the flow rows' and the size rows' (the ranking window), each once. */
export function askedWindows(rankMinutes: number): number[] { return [...new Set([...PULSE_MINUTES, rankMinutes])].sort((a, b) => a - b); }
export const rankMinutes = (settings: Pick<CvdSettings, 'rank'>): number => Math.round(RANK_MS[settings.rank] / 60_000);

// ---- size bands -------------------------------------------------------------------------------------------------------------------------

/**
 * One row of the size group: the market orders from `lo` to under `hi` (BTC's sizes; `hi` null: no top), called by their sizes (`label` for
 * the row, which has "USD" in its heading; `range` with the dollar signs, for a sentence).
 */
export interface SizeBand { lo: number; hi: number | null; label: string; range: string }

function bandRange(lo: number, hi: number | null, money: (usd: number) => string): string {
  return lo === 0 ? `< ${money(scaledUsd(hi!))}` : hi === null ? `≥ ${money(scaledUsd(lo))}` : `${money(scaledUsd(lo))}–${money(scaledUsd(hi))}`;
}
const dollars = (v: number): string => `$${sizeText(v)}`;

/**
 * The bands the trades are split into: retail (under `stripRetailUsd`, on one row, or with the orders under the floor on a row of their own),
 * what lies between, and whales (from `stripWhaleUsd`). A band with nothing in it is left out, so the strip has two to four size rows.
 */
export function sizeBands(c: Pick<CvdSettings, 'stripRetailUsd' | 'stripWhaleUsd' | 'stripSmall'>): SizeBand[] {
  const retail = Math.max(SIZE_FLOOR_USD, c.stripRetailUsd), whale = Math.max(retail, c.stripWhaleUsd);
  const spans: [number, number | null][] = c.stripSmall && retail > SIZE_FLOOR_USD ? [[0, SIZE_FLOOR_USD], [SIZE_FLOOR_USD, retail]] : [[0, retail]];
  if (whale > retail) spans.push([retail, whale]);
  spans.push([whale, null]);
  return spans.map(([lo, hi]) => ({ lo, hi, label: bandRange(lo, hi, sizeText), range: bandRange(lo, hi, dollars) }));
}

/** The size lines a sizes question asks for, for the coin on screen: the bands' edges that are not box edges (see `linesToAsk`). */
export const bandCuts = (bands: readonly SizeBand[]): number[] => linesToAsk(bands.flatMap(b => b.hi === null ? [b.lo] : [b.lo, b.hi]), scaledUsd);

/** The band a trade of `usd` (the coin's own USD) belongs to, as an index into `bands`, or -1 for none. */
export function bandOf(bands: readonly SizeBand[], usd: number): number {
  const size = usd / sizeScale();
  return bands.findIndex(b => size >= b.lo && (b.hi === null || size < b.hi));
}

/**
 * The size rows whose leading lamp lights for these trades that just printed: the row each trade of a counted instrument belongs to (a
 * trade of an instrument the ALL VENUES row does not count says nothing about it). The print stream starts at the floor, so the row of the
 * orders under it never lights.
 */
export function flashBands(bands: readonly SizeBand[], counted: ReadonlySet<string>, prints: readonly { id: string; usd: number }[]): number[] {
  const rows = new Set<number>();
  for (const p of prints) {
    if (!counted.has(p.id)) continue;
    const band = bandOf(bands, p.usd);
    if (band >= 0 && (bands[band]!.hi === null || bands[band]!.hi! > SIZE_FLOOR_USD)) rows.add(band);
  }
  return [...rows];
}

/**
 * The USD of the orders from `lo` (BTC's size) in a window: everything from 0; the boxes from the floor (exact); a line's own sums when the
 * window has them for that line (`cuts`, the coin's sizes, as asked); otherwise the boxes at the nearest edge, which `exact` false says.
 */
export function overIn(window: SizesWindow, lo: number, cuts: readonly number[]): { buy: number; sell: number; exact: boolean } {
  if (lo === 0) return { buy: window.buy.reduce((a, b) => a + b, 0), sell: window.sell.reduce((a, b) => a + b, 0), exact: true };
  const size = scaledUsd(lo), k = cuts.findIndex(c => Math.abs(c - size) <= 1e-6 * size);
  if (k >= 0 && window.over) return { buy: window.over[2 * k]!, sell: window.over[2 * k + 1]!, exact: true };
  return overFromBoxes(window.buy, window.sell, size, sizeScale());
}

// ---- rows -------------------------------------------------------------------------------------------------------------------------------

export interface StripRow {
  /** `pulse:5` or `size:2`: the same row keeps its key. `range` is what a sentence calls a size row (the dollar range with its signs). */
  key: string; label: string; range: string;
  buy: number; sell: number;
  /** A size row whose line between box edges had no sums of its own here (an older server, or minutes not yet filled in): taken at the nearest edge. */
  approx?: boolean;
  /** Buys' share of the row's own volume (0 to 1), or null when nothing traded. */
  share: number | null;
  /** The row's share of all the size rows' volume (size rows only). */
  weight: number | null;
  /** Of the `minutes` the row spans, how many were recorded (null when that is not known), and whether that is too few to call the row complete. */
  covered: number | null; minutes: number; partial: boolean;
}

/** Whether `covered` of `minutes` is too few to call a window complete: under nine in ten, and more than the one minute that a clock's edge can cost. */
export function isPartial(covered: number | null, minutes: number): boolean { return covered !== null && minutes - covered > 1 && covered < 0.9 * minutes; }

const shareOf = (buy: number, sell: number): number | null => buy + sell > 0 ? buy / (buy + sell) : null;

/** The four taker-flow rows: buys and sells of the instruments over the last N minutes up to the second `nowSec`, as the ALL VENUES row counts its window. */
export function pulseRows(flow: FlowBook, ids: readonly string[], nowSec: number, recorded: (minutes: number) => number | null): StripRow[] {
  return PULSE_MINUTES.map(minutes => {
    const from = nowSec - minutes * 60 + 1;
    let buy = 0, sell = 0;
    for (const id of ids) { const series = flow.get(id); if (series && !series.empty) { buy += series.buy(from, nowSec); sell += series.sell(from, nowSec); } }
    const covered = recorded(minutes);
    const label = PULSE_LABELS[minutes] ?? `${minutes}m`;
    return { key: `pulse:${minutes}`, label, range: label, buy, sell, share: shareOf(buy, sell), weight: null, covered, minutes, partial: isPartial(covered, minutes) };
  });
}

/**
 * The size rows from the recorder's window (null: nothing known yet, the rows are idle): each band is the orders from its bottom line less
 * those from its top line, with `cuts` the lines the window was asked for (see `overIn`).
 */
export function sizeRows(bands: readonly SizeBand[], window: SizesWindow | null, minutes: number, cuts: readonly number[] = []): StripRow[] {
  const sums = bands.map(b => {
    if (!window) return { buy: 0, sell: 0, approx: false };
    const from = overIn(window, b.lo, cuts), to = b.hi === null ? { buy: 0, sell: 0, exact: true } : overIn(window, b.hi, cuts);
    return { buy: Math.max(0, from.buy - to.buy), sell: Math.max(0, from.sell - to.sell), approx: !from.exact || !to.exact };
  });
  const total = sums.reduce((a, s) => a + s.buy + s.sell, 0), covered = window ? window.stats : null;
  return bands.map((b, i) => {
    const { buy, sell, approx } = sums[i]!;
    return { key: `size:${i}`, label: approx ? `≈${b.label}` : b.label, range: b.range, buy, sell, ...(approx ? { approx } : {}), share: shareOf(buy, sell), weight: window && total > 0 ? (buy + sell) / total : null, covered, minutes, partial: isPartial(covered, minutes) };
  });
}

/** What the size group knows: its rows are real, still being asked for, or cannot be had from this source. */
export type SizeState = 'ready' | 'loading' | 'unavailable' | 'empty';
export interface StripData {
  /** The words over the first group, and the ranking window's short name (`1H`). */
  heading: string; window: string;
  pulse: StripRow[];
  size: { state: SizeState; rows: StripRow[]; covered: number | null; minutes: number; partial: boolean };
}
export interface StripInput {
  flow: FlowBook; counted: readonly string[]; nowSec: number;
  settings: CvdSettings; scope: Scope;
  /** The last sizes answer for exactly these instruments and windows (null: none), and how asking went. */
  sizes: SizesAnswer | null; state: 'ready' | 'loading' | 'unavailable';
}

/** The words over the strip, as the aggregate row says them: which kind of market the filter leaves in. */
export const heading = (scope: Scope): string => scope === 'all' ? t('ALL VENUES') : scope === 'spot' ? t('ALL SPOT VENUES') : t('ALL PERP VENUES');

export function buildStrip(i: StripInput): StripData {
  const rank = rankMinutes(i.settings), bands = sizeBands(i.settings);
  const at = (minutes: number): SizesWindow | null => i.sizes?.windows.find(w => w.minutes === minutes) ?? null;
  const pulse = pulseRows(i.flow, i.counted, i.nowSec, minutes => at(minutes)?.seen ?? null);
  const window = at(rank), state: SizeState = !i.counted.length ? 'empty' : i.state === 'ready' && !window ? 'loading' : i.state;
  const rows = sizeRows(bands, state === 'ready' ? window : null, rank, bandCuts(bands)), covered = state === 'ready' && window ? window.stats : null;
  return { heading: heading(i.scope), window: windowName(rank * 60), pulse, size: { state, rows, covered, minutes: rank, partial: isPartial(covered, rank) } };
}

// ---- dots -------------------------------------------------------------------------------------------------------------------------------

/**
 * One dot of a row: which side it counts for (the middle two are neither) and how it is lit. The side that is ahead is lit and the other
 * dim, as the bars in aggr.trade are; a row with nothing in it is dark throughout.
 */
export type Led = 'buy-on' | 'buy-dim' | 'buy-off' | 'sell-on' | 'sell-dim' | 'sell-off' | 'mid-on' | 'mid-off';
export interface LedRow {
  dots: Led[];
  /** The dot at the leading edge of the side that is ahead (it wears the ring, like the peak LED of a level meter), or -1 when neither is. */
  lead: number;
}

/** A row of `n` dots (even: the middle two mark an even split) for buys' share `share`: buys fill from the left, sells from the right. */
export function ledRow(share: number | null, n: number): LedRow {
  const mid = n / 2, dots: Led[] = [];
  if (share === null) {
    for (let i = 0; i < n; i++) dots.push(i === mid - 1 || i === mid ? 'mid-off' : i < mid ? 'buy-off' : 'sell-off');
    return { dots, lead: -1 };
  }
  const buyDots = Math.round(n * share), buyAhead = share > 0.5, sellAhead = share < 0.5;
  for (let i = 0; i < n; i++) {
    if (i === mid - 1 || i === mid) { dots.push('mid-on'); continue; }
    const onBuy = i < buyDots, lit = share === 0.5 || (onBuy ? buyAhead : sellAhead);
    dots.push(onBuy ? (lit ? 'buy-on' : 'buy-dim') : (lit ? 'sell-on' : 'sell-dim'));
  }
  return { dots, lead: share === 0.5 ? -1 : buyAhead ? buyDots - 1 : buyDots };
}

/** How many of the ten weight dots a row's share of the volume lights. */
export const weightDots = (weight: number | null): number => weight === null ? 0 : Math.max(0, Math.min(10, Math.round(weight * 10)));

/** A share as the strip prints it. */
export const percent = (share: number | null): string => share === null ? '–' : `${Math.round(share * 100)}%`;
/** A band's share of the volume: a share too small to round to one says so. */
export const weightText = (weight: number | null): string => weight === null ? '–' : weight > 0 && weight < 0.005 ? '<1%' : `${Math.round(weight * 100)}%`;

// ---- layout -----------------------------------------------------------------------------------------------------------------------------

/** The sizes of the strip in CSS px: its inner padding, the heading line and a row, the gap between the groups, a dot and the distance from one dot to the next. */
export const GEOMETRY = { pad: 5, headH: 11, rowH: 10, groupGap: 4, dot: 4, pitch: 6, lead: 12, labelW: 48, valueW: 96 } as const;

/** The strip's height for `sizeRows` size rows: two headings, the four flow rows and the size rows, the gap between them and the padding. */
export const stripHeight = (sizeRows: number): number => GEOMETRY.pad * 2 + GEOMETRY.headH * 2 + (PULSE_MINUTES.length + sizeRows) * GEOMETRY.rowH + GEOMETRY.groupGap + 2;

/** Which row is at `y` px from the strip's top (null between rows, on a heading or outside). */
export function rowAt(y: number, sizeRows: number): { group: 'pulse' | 'size'; index: number } | null {
  const g = GEOMETRY;
  let top = g.pad + 1 + g.headH;
  for (let i = 0; i < PULSE_MINUTES.length; i++) { if (y >= top && y < top + g.rowH) return { group: 'pulse', index: i }; top += g.rowH; }
  top += g.groupGap + g.headH;
  for (let i = 0; i < sizeRows; i++) { if (y >= top && y < top + g.rowH) return { group: 'size', index: i }; top += g.rowH; }
  return null;
}

// ---- words ------------------------------------------------------------------------------------------------------------------------------

/** The box under the pointer on a row: its figures in dollars, and what the recording of its window covers. Pure, so a test reads the words. */
export function rowLines(row: StripRow, data: StripData): InfoLine[] {
  const pulse = row.key.startsWith('pulse:');
  const out: InfoLine[] = [
    { text: pulse ? t('Taker flow, {window}', { window: row.label }) : t('Market orders {band}, {window}', { band: row.range, window: data.window }), bold: true },
    { text: data.heading, color: 'muted' },
  ];
  if (row.share === null) out.push({ text: t('Nothing traded in this window.'), color: 'muted', wrap: true, rule: true });
  else {
    const net = row.buy - row.sell;
    out.push({ label: t('Buys / sells'), text: `${plainUsd(row.buy)} / ${plainUsd(row.sell)}`, rule: true });
    out.push({ label: t('Net'), text: signedUsd(net), color: net > 0 ? 'buy' : net < 0 ? 'sell' : 'text' });
    out.push({ label: t('Buy share'), text: percent(row.share) });
    if (row.weight !== null) out.push({ label: t('Share of volume'), text: weightText(row.weight) });
  }
  if (row.approx) out.push({ text: t('≈ About: for some of these minutes only the size boxes are known (an older server, or minutes it has not filled in yet), so this line is drawn at the nearest box edge.'), color: 'muted', wrap: true });
  if (row.covered !== null) {
    out.push({ label: t('Recorded'), text: t('{covered} of {minutes} minutes', { covered: row.covered, minutes: row.minutes }), bold: row.partial, rule: row.share === null });
    if (row.partial) out.push({ text: t('Part of this window was not recorded: this page or the server was off, or recording began later. The figures cover the part that was.'), color: 'muted', wrap: true });
  }
  return out;
}

/** The note at the size group's heading when its window is not fully recorded: `47/60 MIN`. */
export const coverageNote = (covered: number, minutes: number): string => t('{covered}/{minutes} MIN', { covered, minutes });
