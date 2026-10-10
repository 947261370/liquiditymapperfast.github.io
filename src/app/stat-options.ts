import { readSize, sizeFromBox } from './sizes.ts';

/** Options shared by the bar-stats strip, the footprint and the store (kept dependency-free so the store can use the defaults). */
export interface StatOptions {
  /** Diagonal imbalance: a level's volume must be at least this many times the opposite volume one row away (3 is the usual default). */
  imbRatio: number;
  /** ... and at least this much USD (default 0). */
  imbMinUsd: number;
  /** Consecutive imbalanced rows on one side that count as a stacked imbalance (default 3). */
  stackedN: number;
  /** Whether a level against an empty row one away (nothing traded there, inside the candle's range) counts as imbalanced (default no). */
  imbZeros: boolean;
  /**
   * Market orders under `retailUsd` are "retail", from `whaleUsd` up "whales" (BTC's sizes, scaled for a coin that trades less; defaults $100K
   * and $500K). Any size from the floor ($25K), where the recording starts keeping the orders one by one; whales never under retail.
   */
  retailUsd: number;
  whaleUsd: number;
  /** Open interest change in the series' own units (base coin) or as USD (change times the bar's close). */
  oiUnits: 'base' | 'usd';
  /** Filled cells shaded by magnitude, or text only coloured by sign. */
  cells: 'filled' | 'text';
}
export const DEFAULT_STAT_OPTIONS: Readonly<StatOptions> = Object.freeze({ imbRatio: 3, imbMinUsd: 0, stackedN: 3, imbZeros: false, retailUsd: 100_000, whaleUsd: 500_000, oiUnits: 'base', cells: 'filled' });

/**
 * Options from storage or a layouts file, field by field, within what the settings allow: a ratio from 1, no negative size, stacks of two
 * rows or more, retail and whale sizes from the floor with whales not under retail (a save from before the sizes were free holds box
 * numbers, read as their edges), and the units and cell styles there are.
 */
export function readStatOptions(raw: unknown): StatOptions {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>, d = DEFAULT_STAT_OPTIONS;
  const num = (v: unknown, lo: number, hi: number, fallback: number): number => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : fallback;
  let retailUsd = readSize(r.retailUsd) ?? sizeFromBox(r.retailMax, 1) ?? d.retailUsd, whaleUsd = readSize(r.whaleUsd) ?? sizeFromBox(r.whaleMin, 0) ?? d.whaleUsd;
  if (whaleUsd < retailUsd) { retailUsd = d.retailUsd; whaleUsd = d.whaleUsd; }
  return {
    imbRatio: num(r.imbRatio, 1, 100, d.imbRatio), imbMinUsd: num(r.imbMinUsd, 0, 1e12, d.imbMinUsd),
    stackedN: typeof r.stackedN === 'number' && Number.isInteger(r.stackedN) && r.stackedN >= 2 && r.stackedN <= 50 ? r.stackedN : d.stackedN,
    imbZeros: typeof r.imbZeros === 'boolean' ? r.imbZeros : d.imbZeros, retailUsd, whaleUsd,
    oiUnits: r.oiUnits === 'usd' ? 'usd' : 'base', cells: r.cells === 'text' ? 'text' : 'filled',
  };
}
