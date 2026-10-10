import test from 'node:test';
import assert from 'node:assert/strict';
import { depthSeries, touchOf, type DepthStore } from '../src/app/depth-series.ts';

const MIN = 60_000, STEP = 1;
/** One instrument's minutes: each a book of `bids` and `asks` as [price, usd], on a grid of `STEP`. */
function store(minutes: { t: number; bids: [number, number][]; asks: [number, number][] }[]): DepthStore {
  const times: number[] = [], counts: number[] = [], bins: number[] = [], bid: number[] = [], ask: number[] = [];
  for (const m of minutes) {
    const rows = new Map<number, [number, number]>();
    for (const [p, usd] of m.bids) rows.set(p / STEP, [usd, rows.get(p / STEP)?.[1] ?? 0]);
    for (const [p, usd] of m.asks) rows.set(p / STEP, [rows.get(p / STEP)?.[0] ?? 0, usd]);
    const sorted = [...rows].sort((a, b) => a[0] - b[0]);
    times.push(m.t); counts.push(sorted.length);
    for (const [b, [u, v]] of sorted) { bins.push(b); bid.push(u); ask.push(v); }
  }
  return { step: STEP, times, counts, bins, bid, ask };
}
/** A book that has the same shape about any price: most of it at the touch, thinning out. */
const bookAt = (t: number, price: number) => ({ t, bids: [[price - 1, 500], [price - 3, 200], [price - 10, 100]] as [number, number][], asks: [[price + 1, 500], [price + 3, 200], [price + 10, 100]] as [number, number][] });

test('a book that keeps its shape while the price climbs has the same depth every minute (no centre from later in the candle)', () => {
  // The price climbs ten a minute for an hour. A centre taken from the hour's close (the old rule) sat above every minute but the last,
  // so the asks at the touch fell out of the ask side and the asks "dropped" ahead of the rise.
  const minutes = Array.from({ length: 60 }, (_, i) => bookAt(i * MIN, 1_000 + 10 * i));
  const s = depthSeries([store(minutes)], MIN, 0, 60 * MIN, 60, 0.02);
  for (let x = 0; x < 60; x++) {
    assert.equal(s.mid[x], 1_000 + 10 * x, `the centre of minute ${x} is that minute's own price`);
    assert.equal(s.bid[x], 800); assert.equal(s.ask[x], 800);
  }
});

test('each side counts its own orders anywhere in the band, so a centre a little off the touch moves nothing from one side to the other', () => {
  // In a minute the price went through, the book's bins cross: asks below the bids. They still count, each as what it was.
  const crossed = { t: 0, bids: [[1_002, 300], [995, 100]] as [number, number][], asks: [[999, 300], [1_005, 100]] as [number, number][] };
  const s = depthSeries([store([crossed])], MIN, 0, MIN, 1, 0.05);
  assert.equal(s.mid[0], (999 + 1_002) / 2);
  assert.equal(s.bid[0], 400); assert.equal(s.ask[0], 400);
});

test('the centre is the median of the instruments\' own, so one stale book does not drag the band', () => {
  const good = (price: number) => store([bookAt(0, price)]);
  const stale = store([{ t: 0, bids: [[600, 50]], asks: [[620, 50]] }]);
  const s = depthSeries([good(1_000), good(1_002), stale, good(1_001)], MIN, 0, MIN, 1, 0.02);
  assert.equal(s.mid[0], 1_001, 'the upper middle of 610, 1000, 1001, 1002');
  assert.equal(s.ask[0], 3 * 800, 'the stale book lies outside the band and adds nothing');
});

test('a book with one side gives no centre; a pixel no book gives one stays empty; minutes in one pixel are averaged', () => {
  assert.ok(Number.isNaN(touchOf(store([{ t: 0, bids: [[99, 10]], asks: [] }]), 0, 1)));
  const s = depthSeries([store([{ t: 0, bids: [[99, 10]], asks: [] }])], MIN, 0, MIN, 1, 0.1);
  assert.ok(Number.isNaN(s.mid[0])); assert.equal(s.bid[0], 0);
  const two = depthSeries([store([bookAt(0, 1_000), { t: MIN, bids: [[999, 100]], asks: [[1_001, 300]] }])], MIN, 0, 2 * MIN, 1, 0.02);
  assert.equal(two.bid[0], (800 + 100) / 2); assert.equal(two.ask[0], (800 + 300) / 2);
});
