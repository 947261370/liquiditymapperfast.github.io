import test from 'node:test';
import assert from 'node:assert/strict';
import { ASKS, BIDS, DepthBars, KEEP_BARS, LIVE_BAR_MS, MAX_DEPTH_BARS, barTotals, fitsBars, missingSpans, neededBars, pixelFlags, type BarReader } from '../src/app/depth-bars.ts';
import type { ColumnSet, ColumnsFrame } from '../src/app/wire.ts';

const H = 3_600_000, T0 = Date.UTC(2026, 9, 10, 0, 0, 0);

test('the candles needed are those on screen and the baseline before them, whole, and none past a replay', () => {
  assert.deepEqual(neededBars(T0 + 20 * 60_000, T0 + 4 * H + 40 * 60_000, H, 3), { from: T0 - 3 * H, to: T0 + 5 * H });
  assert.deepEqual(neededBars(T0 + 20 * 60_000, T0 + 4 * H + 40 * 60_000, H, 3, T0 + 3 * H + 30 * 60_000), { from: T0 - 3 * H, to: T0 + 3 * H }, 'the candle holding the moment would carry its future');
  assert.equal(fitsBars({ from: 0, to: MAX_DEPTH_BARS * 60_000 }, 60_000), true);
  assert.equal(fitsBars({ from: 0, to: (MAX_DEPTH_BARS + 1) * 60_000 }, 60_000), false, 'too many: judged per pixel column');
});

test('only what is not held is asked for, at either end', () => {
  assert.deepEqual(missingSpans(null, { from: 3, to: 12 }), [{ from: 3, to: 12 }]);
  assert.deepEqual(missingSpans({ from: 5, to: 10 }, { from: 3, to: 12 }), [{ from: 3, to: 5 }, { from: 10, to: 12 }]);
  assert.deepEqual(missingSpans({ from: 5, to: 10 }, { from: 6, to: 9 }), []);
  assert.deepEqual(missingSpans({ from: 5, to: 10 }, { from: 10, to: 14 }), [{ from: 10, to: 14 }], 'touching: the rest');
  assert.deepEqual(missingSpans({ from: 5, to: 10 }, { from: 20, to: 24 }), [{ from: 20, to: 24 }], 'elsewhere: all of it');
  assert.deepEqual(missingSpans({ from: 5, to: 10 }, { from: 7, to: 7 }), []);
});

test('a pixel column takes the flag of the candle it lies in', () => {
  assert.deepEqual([...pixelFlags(Uint8Array.of(0, BIDS, 0, ASKS), 0, 10, 5, 35, 6)], [0, BIDS, BIDS, 0, 0, ASKS]);
  assert.deepEqual([...pixelFlags(Uint8Array.of(0, BIDS), 0, 10, 0, 20, 1)], [BIDS], 'a pixel wider than a candle takes a flagged one inside it');
});

/** Columns merged to candles of `tf` over [from, to): two instruments, a bid at 99 and an ask at 101, sized by `book`. */
function frame(ids: readonly string[], from: number, to: number, tf: number, book: (t: number) => { bid: number; ask: number } | null): ColumnsFrame {
  const instruments: ColumnSet[] = ids.map(id => {
    const times: number[] = [], counts: number[] = [], samples: number[] = [], bins: number[] = [], bid: number[] = [], ask: number[] = [];
    for (let t = from; t < to; t += tf) { const b = book(t); if (!b) continue; times.push(t); counts.push(2); samples.push(60); bins.push(99, 101); bid.push(b.bid / 2, 0); ask.push(0, b.ask / 2); }
    return { id, step: 1, times, counts, samples, bins: Int32Array.from(bins), bid: Float32Array.from(bid), ask: Float32Array.from(ask) };
  });
  return { from, to, stepMs: tf, instruments };
}

test('each candle is the instruments that have it added up; a candle none has is absent', () => {
  const f = frame(['a', 'b'], T0, T0 + 3 * H, H, t => t === T0 + H ? null : { bid: 600, ask: 400 });
  assert.deepEqual(barTotals(f, { from: T0, to: T0 + 3 * H }, H, 0.2).map(b => [b.t - T0, b.bid, b.ask]), [[0, 600, 400], [2 * H, 600, 400]]);
});

/** An ordinary candle: a balance within a few percent, a different one each hour; one extreme candle, with the bids far heavier. */
const EXTREME = T0 + 100 * H;
const book = (t: number) => t === EXTREME ? { bid: 1_800, ask: 200 } : { bid: 1_000 + ((t / H) * 37) % 50 - 25, ask: 1_000 };
function rig() {
  const asked: [number, number][] = [];
  const read: BarReader = (ids, from, to, stepMs) => { asked.push([(from - T0) / H, (to - T0) / H]); return Promise.resolve(frame(ids, from, to, stepMs, t => t < T0 + 200 * H ? book(t) : null)); };
  return { asked, bars: new DepthBars(read) };
}
const settle = () => new Promise(r => setImmediate(r));
const highlight = { length: 72, mult: 2 };

test('the verdict on a candle is the same whatever the view: zoomed in or out, panned either way', async () => {
  const { bars } = rig(), now = T0 + 300 * H;
  const verdicts = async (t0: number, t1: number) => {
    const need = neededBars(t0, t1, H, highlight.length);
    for (let i = 0; i < 4; i++) { bars.ensure(['a', 'b'], 0.2, H, need, now, () => {}); await settle(); }
    const flags = bars.flags(need, H, highlight), out = new Map<number, number>();
    flags.forEach((f, k) => { const t = need.from + k * H; if (t >= t0 && t < t1) out.set(t, f); });
    return out;
  };
  const wide = await verdicts(T0 + 80 * H, T0 + 130 * H), narrow = await verdicts(T0 + 98 * H + 20 * 60_000, T0 + 103 * H), panned = await verdicts(T0 + 90 * H, T0 + 140 * H);
  assert.equal(wide.get(EXTREME), BIDS, 'the extreme candle is flagged, bids heavier');
  for (const other of [narrow, panned]) for (const [t, f] of other) if (wide.has(t)) assert.equal(f, wide.get(t), `candle ${(t - T0) / H} h`);
  assert.equal(narrow.get(EXTREME), BIDS); assert.equal(panned.get(EXTREME), BIDS);
});

test('candles are asked for once, then only the ends a pan uncovers; another band starts again', async () => {
  const { bars, asked } = rig(), now = T0 + 300 * H;
  const go = async (t0: number, t1: number, range = 0.2) => { for (let i = 0; i < 3; i++) { bars.ensure(['a', 'b'], range, H, neededBars(t0, t1, H, 10), now, () => {}); await settle(); } };
  await go(T0 + 50 * H, T0 + 60 * H);
  assert.deepEqual(asked, [[40, 60]], 'the screen and ten candles before it');
  await go(T0 + 52 * H, T0 + 63 * H);
  assert.deepEqual(asked.slice(1), [[60, 63]], 'panned right: the three new candles');
  await go(T0 + 45 * H, T0 + 55 * H);
  assert.deepEqual(asked.slice(2), [[35, 40]], 'panned left: the five before');
  await go(T0 + 45 * H, T0 + 55 * H, 0.05);
  assert.deepEqual(asked.slice(3), [[35, 55]], 'another band: everything again');
});

test('the forming candle is read again once a minute while it is in view, and a candle read before it closed is read again once whole', async () => {
  const { bars, asked } = rig();
  let now = T0 + 150 * H + 10 * 60_000;
  const need = () => neededBars(T0 + 140 * H, now + 3 * H, H, 5, (Math.floor(now / H) + 1) * H);
  const go = async () => { for (let i = 0; i < 3; i++) { bars.ensure(['a', 'b'], 0.2, H, need(), now, () => {}); await settle(); } };
  await go();
  assert.deepEqual(asked, [[135, 151]], 'up to the end of the forming candle, not into the view\'s empty margin');
  now += LIVE_BAR_MS - 1; await go();
  assert.equal(asked.length, 1, 'not before a minute');
  now += 1; await go();
  assert.deepEqual(asked.slice(1), [[150, 151]], 'the forming candle');
  now = T0 + 151 * H + 20_000; await go();
  assert.deepEqual(asked.slice(2), [[150, 152]], 'the candle that closed, now whole, with the new one in the same question');
});

test('on a live one-minute chart a candle that closes extreme is flagged, however the view moves on each minute', async () => {
  // The recording of a minute is whole only once it has ended: read while forming, the extreme minute looks ordinary.
  const M = 60_000, start = T0 + 300 * M, extreme = start + 5 * M;
  let now = start;
  const asked: [number, number][] = [];
  const bars = new DepthBars((ids, from, to, stepMs) => { asked.push([from, to]); return Promise.resolve(frame(ids, from, to, stepMs, t => t + M > now ? (t > now ? null : { bid: 1_000, ask: 1_000 }) : t === extreme ? { bid: 1_800, ask: 200 } : book(t))); });
  for (let step = 0; step < 10; step++) {
    now = start + step * M + 20_000;
    // The view follows the live edge with a margin to its right, as the map does.
    const need = neededBars(now - 40 * M, now + 8 * M, M, 72, (Math.floor(now / M) + 1) * M);
    for (let i = 0; i < 4; i++) { bars.ensure(['a', 'b'], 0.2, M, need, now, () => {}); await settle(); }
  }
  const need = neededBars(now - 40 * M, now + 8 * M, M, 72, (Math.floor(now / M) + 1) * M), flags = bars.flags(need, M, highlight);
  assert.equal(flags[(extreme - need.from) / M], BIDS, 'read again once whole, and flagged');
  assert.ok(asked.every(([, to]) => to <= (Math.floor(now / M) + 1) * M), 'nothing asked past the forming candle');
});

test('a long view is asked for a week at a time, newest first, and what an answer leaves out is asked for again', async () => {
  const H4 = 4 * H, asked: [number, number][] = [];
  let cut = true;
  const bars = new DepthBars((ids, from, to, stepMs) => {
    asked.push([(from - T0) / H4, (to - T0) / H4]);
    // The first answer is cut short, as the server cuts a question longer than eight days (here: it skips the first six candles).
    const f = frame(ids, from, to, stepMs, book);
    if (cut) { cut = false; return Promise.resolve({ ...f, from: from + 6 * H4 }); }
    return Promise.resolve(f);
  });
  const now = T0 + 600 * H4, need = neededBars(T0 + 100 * H4, T0 + 600 * H4, H4, 72, (Math.floor(now / H4) + 1) * H4);
  for (let i = 0; i < 20; i++) { bars.ensure(['a', 'b'], 0.2, H4, need, now, () => {}); await settle(); }
  assert.deepEqual(asked.slice(0, 2), [[558, 600], [522, 564]], 'a week (42 candles) at a time from the newest, and the six the first answer left out again');
  assert.ok(asked.every(([from, to]) => to - from <= 42), 'never more than a week');
  assert.equal(Math.min(...asked.map(([from]) => from)), 28, 'down to the start of the baseline');
});

test('no more than KEEP_BARS candles are kept, however far the view travels', async () => {
  const bars = new DepthBars((ids, from, to, stepMs) => Promise.resolve(frame(ids, from, to, stepMs, book))), now = T0 + 5_000 * H;
  for (let t0 = 100; t0 < 4_000; t0 += 150) {
    const need = neededBars(T0 + t0 * H, T0 + (t0 + 100) * H, H, 72);
    for (let i = 0; i < 4; i++) { bars.ensure(['a', 'b'], 0.2, H, need, now, () => {}); await settle(); }
    assert.ok(bars.size <= KEEP_BARS, `${bars.size} candles held at ${t0} h`);
  }
});
