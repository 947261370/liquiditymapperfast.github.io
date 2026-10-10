import type { ColumnsFrame } from './wire.ts';
import { depthByStore } from './depth-series.ts';
import { imbalanceFlags } from './panes/pane-cards.ts';

/**
 * The Depth pane's highlight, judged a candle at a time. Each candle is the recording merged over exactly that candle (the columns question
 * with a step of the timeframe: the server and the browser engine align such windows to it), so a candle's bids and asks are the same
 * whatever the map's zoom; and the candles asked for reach `length` candles before the first one on screen, so each is judged against all
 * of the candles Highlights says, never against what happens to be loaded. The verdict depends on time alone: zooming and panning do not
 * change it. Judged per pixel column instead, it changed with both (a pixel averages other minutes at each zoom, and its baseline was the
 * pixels to its left on screen).
 */

/** The most candles judged one by one (each is a merged column of every instrument, about 50 KB a candle for BTC's 29 markets). */
export const MAX_DEPTH_BARS = 600;
/** The forming candle is asked for again this often while it is in view. */
export const LIVE_BAR_MS = 60_000;
/** A candle is whole this long after it ends: the recorder commits its last minute at its first sample of the next one (every 5 s). */
export const SETTLE_MS = 15_000;
/** The most one question asks: 200 candles, and never more than a week (the server answers at most eight days of columns). */
const CHUNK_BARS = 200, CHUNK_MS = 7 * 24 * 3_600_000;
/** The candles kept about the view; others are forgotten, and asked for again if the view comes back to them. */
export const KEEP_BARS = 3 * MAX_DEPTH_BARS;

/** Whole candles [from, to). */
export interface BarSpan { from: number; to: number }

/**
 * The candles the highlight needs for a view: those on screen and the `length` before the first of them, ending at `until`: in a replay its
 * moment (a candle containing it would carry its future), live the end of the forming candle (the view's margin to the right holds no
 * recording, and asking for it would push the server's eight days of answer away from the candles before).
 */
export function neededBars(t0: number, t1: number, tf: number, length: number, until = Infinity): BarSpan {
  const from = Math.floor(t0 / tf) * tf - length * tf;
  return { from, to: Math.max(from, Math.min(Math.ceil(t1 / tf) * tf, Math.floor(until / tf) * tf)) };
}

/** Whether a view's candles can be judged one by one, or are too many (a fine timeframe zoomed far out): then each pixel column is. */
export const fitsBars = (need: BarSpan, tf: number): boolean => (need.to - need.from) / tf <= MAX_DEPTH_BARS;

/** The stretches of `need` not in `have` (none, one, or one at each end; all of it when `have` is empty or does not touch it). */
export function missingSpans(have: BarSpan | null, need: BarSpan): BarSpan[] {
  if (!(need.to > need.from)) return [];
  if (!have || !(have.to > have.from) || have.to < need.from || have.from > need.to) return [need];
  const out: BarSpan[] = [];
  if (need.from < have.from) out.push({ from: need.from, to: have.from });
  if (need.to > have.to) out.push({ from: have.to, to: need.to });
  return out;
}

/** Each candle's bids and asks inside the band, from a frame of columns merged to the candle: the instruments that have it added up, absent where none has. */
export function barTotals(frame: ColumnsFrame, span: BarSpan, tf: number, range: number): { t: number; bid: number; ask: number }[] {
  const n = Math.max(0, Math.round((span.to - span.from) / tf)), by = depthByStore(frame.instruments, tf, span.from, span.to, n, range), out: { t: number; bid: number; ask: number }[] = [];
  for (let x = 0; x < n; x++) {
    let bid = 0, ask = 0, any = false;
    for (let i = 0; i < frame.instruments.length; i++) if (by.present[i]![x]) { bid += by.bid[i]![x]!; ask += by.ask[i]![x]!; any = true; }
    if (any) out.push({ t: span.from + x * tf, bid, ask });
  }
  return out;
}

/** What a flag says: nothing stands out, or the bids (`BIDS`) or the asks (`ASKS`) are unusually the heavier side. */
export const BIDS = 1, ASKS = 2;

/** The flag of each of `w` pixel columns over [t0, t1): that of the first flagged candle it overlaps (`flags[k]` is the candle at `from + k * tf`). */
export function pixelFlags(flags: Uint8Array, from: number, tf: number, t0: number, t1: number, w: number): Uint8Array {
  const out = new Uint8Array(Math.max(0, w)), px = (t1 - t0) / w;
  if (!(px > 0)) return out;
  for (let x = 0; x < w; x++) {
    const a = t0 + x * px, b = a + px;
    for (let k = Math.max(0, Math.floor((a - from) / tf)); k < flags.length && from + k * tf < b; k++) if (flags[k]) { out[x] = flags[k]!; break; }
  }
  return out;
}

/** Highlights' rule over a series of bids and asks (`columnsPerBar` entries a candle), with the heavier side of each entry it flags. */
export function sideFlags(bid: ArrayLike<number>, ask: ArrayLike<number>, highlight: { length: number; mult: number }, columnsPerBar: number): Uint8Array {
  const flags = imbalanceFlags(bid, ask, highlight, columnsPerBar);
  for (let i = 0; i < flags.length; i++) if (flags[i]) flags[i] = bid[i]! > ask[i]! ? BIDS : ASKS;
  return flags;
}

/** The recording of instruments over [from, to) merged to steps of `stepMs` (the page's columns question). */
export type BarReader = (ids: string[], from: number, to: number, stepMs: number) => Promise<ColumnsFrame>;

/**
 * The candles held for the highlight, by instruments, band and timeframe, one question at a time. In this order: a candle read before it was
 * whole (forming, or just ended) is read again once it is; then what the view needs and is not held, a chunk at a time, the newest first;
 * then the forming candle once a minute. At most KEEP_BARS candles about the view are kept. `version` moves whenever a candle's numbers do.
 */
export class DepthBars {
  #key = '';
  /** The candles held: every candle of this span has been asked for (one with no recording is absent from `#bars`). */
  #have: BarSpan | null = null;
  readonly #bars = new Map<number, { bid: number; ask: number }>();
  /** Candles read before they were whole: read again once they are. */
  readonly #open = new Set<number>();
  #busy = false; #liveAt = 0; #failedAt = 0;
  version = 0;
  #judged: { key: string; flags: Uint8Array } | null = null;

  constructor(private read: BarReader) {}

  /** How many candles are held. */
  get size(): number { return this.#bars.size; }

  /**
   * Make sure the candles of `need` are held, asking for what is not; `now` is the real time (the forming candle is the one holding it).
   * `need` must not reach past the forming candle (`neededBars` with `until`): the future holds no recording. `changed` is called once
   * an answer has been taken in.
   */
  ensure(ids: readonly string[], range: number, tf: number, need: BarSpan, now: number, changed: () => void): void {
    const key = `${[...ids].sort().join(',')}|${range}|${tf}`;
    if (key !== this.#key) { this.#key = key; this.#have = null; this.#bars.clear(); this.#open.clear(); this.#liveAt = 0; this.version++; }
    if (this.#busy || !ids.length || now - this.#failedAt < 30_000) return;
    const forming = Math.floor(now / tf) * tf, ask = this.#next(need, tf, now, forming);
    if (!ask) return;
    this.#busy = true;
    this.read([...ids], ask.from, ask.to, tf).then(frame => {
      if (key !== this.#key) return;
      // The server answers at most eight days of columns: a question it cut short holds only what came back.
      const got = { from: Math.max(ask.from, Math.ceil(frame.from / tf) * tf), to: ask.to };
      for (let t = got.from; t < got.to; t += tf) {
        this.#bars.delete(t);
        if (t + tf + SETTLE_MS <= now) this.#open.delete(t); else this.#open.add(t);
      }
      for (const bar of barTotals(frame, got, tf, range)) this.#bars.set(bar.t, { bid: bar.bid, ask: bar.ask });
      if (ask.from <= forming && forming < ask.to) this.#liveAt = now;
      this.#hold(got, need, tf);
      this.version++; changed();
    }, () => { this.#failedAt = now; }).finally(() => { this.#busy = false; });
  }

  /** What to ask next (see the class), or null. */
  #next(need: BarSpan, tf: number, now: number, forming: number): BarSpan | null {
    const chunk = Math.max(1, Math.min(CHUNK_BARS, Math.floor(CHUNK_MS / tf))) * tf;
    let first = Infinity;
    for (const t of this.#open) if (t >= need.from && t < need.to && t + tf + SETTLE_MS <= now && t < first) first = t;
    if (first < Infinity) return { from: first, to: Math.min(need.to, first + chunk, Math.max(first + tf, forming + tf)) };
    const missing = missingSpans(this.#have, need).at(-1);
    if (missing) return { from: Math.max(missing.from, missing.to - chunk), to: missing.to };
    if (forming >= need.from && forming < need.to && now - this.#liveAt >= LIVE_BAR_MS) return { from: forming, to: forming + tf };
    return null;
  }

  /** Join what came back to what is held (a stretch that does not touch it replaces it), and keep at most KEEP_BARS candles about the view. */
  #hold(got: BarSpan, need: BarSpan, tf: number): void {
    const have = this.#have;
    let span = have && got.from <= have.to && got.to >= have.from ? { from: Math.min(have.from, got.from), to: Math.max(have.to, got.to) } : got;
    if ((span.to - span.from) / tf > KEEP_BARS) {
      const margin = Math.max(0, Math.floor((KEEP_BARS - (need.to - need.from) / tf) / 2)) * tf;
      span = { from: Math.max(span.from, need.from - margin), to: Math.min(span.to, need.to + margin) };
    }
    this.#have = span;
    for (const t of this.#bars.keys()) if (t < span.from || t >= span.to) this.#bars.delete(t);
    for (const t of this.#open) if (t < span.from || t >= span.to) this.#open.delete(t);
  }

  /** The flags of the candles of `need` (Highlights' rule over the candles held; a candle not held is not judged and not flagged). */
  flags(need: BarSpan, tf: number, highlight: { length: number; mult: number }): Uint8Array {
    const key = `${this.version}|${need.from}|${need.to}|${tf}|${highlight.length}|${highlight.mult}`;
    if (this.#judged?.key === key) return this.#judged.flags;
    const n = Math.max(0, Math.round((need.to - need.from) / tf)), bid = new Float64Array(n), ask = new Float64Array(n);
    for (let k = 0; k < n; k++) { const bar = this.#bars.get(need.from + k * tf); bid[k] = bar?.bid ?? 0; ask[k] = bar?.ask ?? 0; }
    const flags = sideFlags(bid, ask, highlight, 1);
    this.#judged = { key, flags };
    return flags;
  }
}
