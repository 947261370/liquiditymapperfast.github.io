import { SIZE_EDGES } from '../shared/footprint.ts';

/**
 * Sizes of market orders as settings: where retail ends and whales begin. The recording keeps every order from SIZE_FLOOR_USD one by one (a
 * list per minute beside the size boxes), so a line can be drawn at any size from there; under it the orders are one sum, and the only line
 * is the floor itself. Settings hold BTC's sizes (a coin that trades less has them scaled, see coin.ts).
 */

/** The smallest line: the second box's edge, from which the recording keeps the orders themselves ($25K for BTC). */
export const SIZE_FLOOR_USD = SIZE_EDGES[1]!;
/** The largest a size setting may be. */
export const SIZE_MAX_USD = 1e10;
/** The sizes offered in the menus beside the size boxes: the box edges, and a few between them. */
export const COMMON_SIZES: readonly number[] = [25_000, 50_000, 75_000, 100_000, 150_000, 250_000, 500_000, 750_000, 1_000_000, 2_000_000, 5_000_000, 10_000_000];

const sizeFormat = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 3 });
/** A size setting written out with the digits it was set with (up to three after the point): `75K`, `1.25M`, where `usd` would show `1.3M`. */
export const sizeText = (v: number): string => !Number.isFinite(v) ? '–' : Math.abs(v) < 1000 ? String(Number(v.toFixed(2))) : sizeFormat.format(v);

/**
 * A size as typed: `100k`, `2.5M`, `1,5M`, `$250,000`, `250.000`, `250 000`, `1b`; null for anything else (and for zero or less). A comma or
 * a dot is a thousands separator when every group after it has three digits and no suffix follows a lone dot (`250,000`, `1.500.000`,
 * `250.000`: a size has no thousandths of a dollar), and a decimal point otherwise (`1,5M`, `2.5M`), as people write them in either habit.
 */
export function parseSize(text: string): number | null {
  let s = text.trim().replace(/^\$/, '').replace(/[\s_]/g, ''), mult = 1;
  const suffix = /[kmb]$/i.exec(s);
  if (suffix) { mult = { k: 1e3, m: 1e6, b: 1e9 }[suffix[0].toLowerCase() as 'k' | 'm' | 'b']; s = s.slice(0, -1); }
  if (!/^[\d.,]*\d[\d.,]*$/.test(s)) return null;
  const grouped = (sep: string): boolean => new RegExp(`^\\d{1,3}(\\${sep}\\d{3})+$`).test(s);
  if (s.includes(',') && s.includes('.')) s = s.lastIndexOf('.') > s.lastIndexOf(',') ? s.replace(/,/g, '') : s.replace(/\./g, '').replace(',', '.');
  else if (s.includes(',')) s = grouped(',') ? s.replace(/,/g, '') : s.split(',').length === 2 ? s.replace(',', '.') : '';
  else if (s.split('.').length > 2 || (!suffix && grouped('.'))) s = grouped('.') ? s.replace(/\./g, '') : '';
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(s)) return null;
  const n = Number((Number(s) * mult).toPrecision(12));      // 123.456 × 1000 is 123455.99999999999 in floating point
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * The USD of the orders from a line, from a minute's or a bar's size boxes, for when the line's own sums are not there (an older server, or
 * minutes recorded before the lists were kept and not yet filled in). At a box edge that is exact; between two edges it is the nearest edge's
 * (`exact` false: the reader says so). `scale` is the coin's size scale.
 */
export function overFromBoxes(buy: readonly number[], sell: readonly number[], cut: number, scale = 1): { buy: number; sell: number; exact: boolean; edge: number } {
  let best = 1, gap = Infinity;
  for (let i = 1; i < SIZE_EDGES.length; i++) { const d = Math.abs(Math.log(SIZE_EDGES[i]! * scale / cut)); if (d < gap) { gap = d; best = i; } }
  const sum = (values: readonly number[]): number => { let s = 0; for (let i = best; i < values.length; i++) s += values[i]!; return s; };
  return { buy: sum(buy), sell: sum(sell), exact: gap < EDGE_TOLERANCE, edge: SIZE_EDGES[best]! * scale };
}

/** How near a box edge a line must be to be that edge: a coin's scaled sizes are rounded to six figures (coin.ts). */
const EDGE_TOLERANCE = 1e-6;
/** Whether a line at `cut` (the coin's USD, `scale` its size scale) is a box edge from the floor up, where the boxes alone are exact. */
export const atBoxEdge = (cut: number, scale = 1): boolean => SIZE_EDGES.some((e, i) => i > 0 && Math.abs(Math.log(e * scale / cut)) < EDGE_TOLERANCE);

/**
 * The size lines to ask a source for, for sizes set as BTC's (`sizes`): those above the floor that are not box edges (the boxes are exact
 * there, and asking costs the source a pass over each minute's orders), each once, in order, scaled for the coin on screen.
 */
export const linesToAsk = (sizes: readonly number[], scaled: (usd: number) => number): number[] =>
  [...new Set(sizes.filter(v => v > SIZE_FLOOR_USD && !atBoxEdge(v)))].sort((a, b) => a - b).map(scaled);

/** A size setting from storage: a USD size from the floor up, or null. */
export const readSize = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) && v >= SIZE_FLOOR_USD && v <= SIZE_MAX_USD ? v : null;

/**
 * A size saved as a box number, from before sizes were free: retail "up to box i" is everything under the next box's edge (`next` 1), whales
 * "from box i" start at its edge (`next` 0). Null when it is not one.
 */
export function sizeFromBox(v: unknown, next: 0 | 1): number | null {
  if (typeof v !== 'number' || !Number.isInteger(v)) return null;
  const edge = SIZE_EDGES[v + next];
  return edge !== undefined && edge >= SIZE_FLOOR_USD ? edge : null;
}
