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
/** The forming candle and the one before it are asked for again this often while they are in view (the one before, because it was last read before it closed). */
export const LIVE_BAR_MS = 60_000;

/** Whole candles [from, to). */
export interface BarSpan { from: number; to: number }

/**
 * The candles the highlight needs for a view: those on screen and the `length` before the first of them, ending at `until` (the replay's
 * moment: a candle containing it would carry its future; live, the end of the forming candle).
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
 * The candles held for the highlight, by instruments, band and timeframe: what is missing is asked for at the ends, one question at a time,
 * and the forming candle (with the one before it) once a minute while it is wanted. `version` moves whenever a candle's numbers do.
 */
export class DepthBars {
  #key = '';
  #have: BarSpan | null = null;
  readonly #bars = new Map<number, { bid: number; ask: number }>();
  #busy = false; #liveAt = 0; #failedAt = 0;
  version = 0;
  #judged: { key: string; flags: Uint8Array } | null = null;

  constructor(private read: BarReader) {}

  /**
   * Make sure the candles of `need` are held, asking for what is not; `now` is the real time (the forming candle is the one holding it).
   * `changed` is called once an answer has been taken in.
   */
  ensure(ids: readonly string[], range: number, tf: number, need: BarSpan, now: number, changed: () => void): void {
    const key = `${[...ids].sort().join(',')}|${range}|${tf}`;
    if (key !== this.#key) { this.#key = key; this.#have = null; this.#bars.clear(); this.#liveAt = 0; this.version++; }
    if (this.#busy || !ids.length || now - this.#failedAt < 30_000) return;
    const forming = Math.floor(now / tf) * tf;
    let ask = missingSpans(this.#have, need)[0];
    // The candles that may still change: the forming one, and the one before it until it has been read whole.
    if (!ask && need.to > forming - tf && now - this.#liveAt >= LIVE_BAR_MS) ask = { from: Math.max(need.from, forming - tf), to: need.to };
    if (!ask) return;
    const asked = ask, live = asked.to > forming - tf;
    this.#busy = true;
    this.read([...ids], asked.from, asked.to, tf).then(frame => {
      if (key !== this.#key) return;
      for (const bar of barTotals(frame, asked, tf, range)) this.#bars.set(bar.t, { bid: bar.bid, ask: bar.ask });
      // What was asked joins what is held when the two touch (the stretches asked for are the ends of it); a stretch elsewhere replaces it.
      const have = this.#have;
      this.#have = have && asked.from <= have.to && asked.to >= have.from ? { from: Math.min(have.from, asked.from), to: Math.max(have.to, asked.to) } : asked;
      if (live) this.#liveAt = now;
      this.version++; changed();
    }, () => { this.#failedAt = now; }).finally(() => { this.#busy = false; });
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
