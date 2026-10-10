import type { ColumnsFrame } from '../wire.ts';
import { depthByStore } from '../depth-series.ts';

const MINUTE = 60_000;
/** Complete minutes the baseline needs before anything is judged: an hour, so a percentile means something. */
export const DEPTH_MIN_BASELINE = 60;

/** One recorded minute: the bid and ask USD inside the band of each instrument that had a column in it. */
export interface DepthMinute { t: number; bid: ReadonlyMap<string, number>; ask: ReadonlyMap<string, number> }
export interface DepthSignal {
  /** The heavier side: `buy` when the bids outweigh the asks. */
  side: 'buy' | 'sell';
  /** This minute's imbalance |bids - asks| / (bids + asks), and the baseline's percentile it went past. */
  share: number; threshold: number;
  /** This minute's bids and asks, and each side's median over the baseline (what is usual). */
  bid: number; ask: number; usualBid: number; usualAsk: number;
  /** Complete minutes in the baseline. */
  minutes: number;
}

/** The minutes of a columns frame (one-minute columns over [from, to)) as band totals per instrument, with the books' own centre (`depthByStore`). */
export function depthMinutes(frame: ColumnsFrame, from: number, to: number, range: number): DepthMinute[] {
  const w = Math.max(0, Math.round((to - from) / MINUTE)), sets = frame.instruments, by = depthByStore(sets, MINUTE, from, to, w, range), out: DepthMinute[] = [];
  for (let x = 0; x < w; x++) {
    const bid = new Map<string, number>(), ask = new Map<string, number>();
    sets.forEach((set, i) => { if (by.present[i]![x]) { bid.set(set.id, by.bid[i]![x]!); ask.set(set.id, by.ask[i]![x]!); } });
    if (bid.size) out.push({ t: from + x * MINUTE, bid, ask });
  }
  return out;
}

/** The value at percentile `pct` (nearest rank) of ascending `sorted`. */
export const percentile = (sorted: readonly number[], pct: number): number => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(pct / 100 * sorted.length) - 1))]!;

/**
 * Whether the balance of the book within a band has become extreme: this minute's imbalance against the minutes of the `hours` before it,
 * as a percentile, so a quiet and a lively day each have their own extreme and nothing is assumed about the shape of the distribution.
 *
 * Only the instruments the baseline usually has are counted (those with a column in at least half of its minutes), and a minute that misses
 * one of them is neither judged nor part of the baseline: a venue that drops out of the recording takes its whole book with it (Binance's
 * perpetual alone is about 40 % of both sides at ±20 %), which is a gap, not the market. A venue gone for more than half the baseline stops
 * being one of them. After a signal the watch waits until the imbalance has come back to the baseline's median: one sound per episode.
 */
export class DepthWatch {
  #minutes: DepthMinute[] = [];
  #armed = true;

  reset(): void { this.#minutes = []; this.#armed = true; }
  /** The newest minute held (0 for none). */
  get newest(): number { return this.#minutes[this.#minutes.length - 1]?.t ?? 0; }
  get size(): number { return this.#minutes.length; }

  /** Take minutes in (newer than those held; any others are ignored) and forget those older than `keepFrom`. */
  add(minutes: readonly DepthMinute[], keepFrom = -Infinity): void {
    for (const m of [...minutes].sort((a, b) => a.t - b.t)) if (m.t > this.newest) this.#minutes.push(m);
    this.forget(keepFrom);
  }
  /** Forget the minutes older than `before`. */
  forget(before: number): void {
    let drop = 0; while (drop < this.#minutes.length && this.#minutes[drop]!.t < before) drop++;
    if (drop) this.#minutes.splice(0, drop);
  }

  /** Judge the minute at `t` against the minutes of the `hours` before it, at percentile `pct`. */
  judge(t: number, { pct, hours }: { pct: number; hours: number }): DepthSignal | null {
    const at = this.#minutes.findIndex(m => m.t === t); if (at < 0) return null;
    const base = this.#minutes.slice(0, at).filter(m => m.t >= t - hours * 3_600_000);
    const seen = new Map<string, number>();
    for (const m of base) for (const id of m.bid.keys()) seen.set(id, (seen.get(id) ?? 0) + 1);
    const usual = [...seen].filter(([, n]) => n * 2 >= base.length).map(([id]) => id);
    if (!usual.length) return null;
    const totals = (m: DepthMinute): { bid: number; ask: number } | null => {
      let bid = 0, ask = 0;
      for (const id of usual) { const b = m.bid.get(id), a = m.ask.get(id); if (b === undefined || a === undefined) return null; bid += b; ask += a; }
      return bid + ask > 0 ? { bid, ask } : null;
    };
    const now = totals(this.#minutes[at]!); if (!now) return null;
    const past = base.map(totals).filter((v): v is { bid: number; ask: number } => v !== null);
    if (past.length < DEPTH_MIN_BASELINE) return null;
    const shareOf = (v: { bid: number; ask: number }): number => Math.abs(v.bid - v.ask) / (v.bid + v.ask);
    const shares = past.map(shareOf).sort((a, b) => a - b), share = shareOf(now), threshold = percentile(shares, pct);
    if (share <= percentile(shares, 50)) this.#armed = true;
    if (!this.#armed || !(share > threshold)) return null;
    this.#armed = false;
    const median = (values: number[]): number => percentile(values.sort((a, b) => a - b), 50);
    return { side: now.bid > now.ask ? 'buy' : 'sell', share, threshold, bid: now.bid, ask: now.ask, usualBid: median(past.map(v => v.bid)), usualAsk: median(past.map(v => v.ask)), minutes: past.length };
  }
}
