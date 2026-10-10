import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createLocalServer } from '../src/server/http.mts';
import { installV2 } from '../src/server/v2/api.mts';
import { HistoryStore } from '../src/server/history.mts';
import { QuotaLedger } from '../src/core/quota.mts';
import { FootprintRecorder, MAX_CUTS, SIZE_EDGES, parseCuts, parseSizes, parseStats, sizeBucket, statsText, type FootprintMinuteRow, type FootprintStore } from '../src/shared/footprint.ts';
import { PrintStream, type Print, type PrintStore } from '../src/shared/prints.ts';

const MIN = 60_000, T0 = 1_800_000_000_000;
type Order = { instrumentId: string; side: 'buy' | 'sell'; t: number; usd: number };
/** Fills recorded and counted as market orders of one fill each, as the order builder does for a venue that reports orders whole. */
function record(recorder: FootprintRecorder, orders: Order[]): void {
  recorder.ingest(orders.map((o, i) => ({ instrumentId: o.instrumentId, tradeId: `${o.t}-${i}-${o.usd}`, side: o.side, price: 85_000, notionalUsd: o.usd, sourceTimestamp: o.t })));
  recorder.countOrders(orders);
}
/** A seeded stream of orders over `minutes` minutes on two instruments, a third of them under $25K, some far over $5M. */
function orders(minutes: number, seed = 7): Order[] {
  let s = seed; const rand = (): number => { s = (s * 1_103_515_245 + 12_345) % 2_147_483_648; return s / 2_147_483_648; };
  return Array.from({ length: minutes * 12 }, (_, i) => ({ instrumentId: i % 3 ? 'a:BTC' : 'b:BTC', side: rand() < 0.5 ? 'buy' as const : 'sell' as const, t: T0 + Math.floor(i / 12) * MIN + (i % 12) * 4_000 + 1, usd: Math.round(10 ** (3.5 + rand() * 3.6)) }));
}
const bucketsFrom = (values: readonly number[], edge: number): number => values.slice(SIZE_EDGES.indexOf(edge)).reduce((a, b) => a + b, 0);

test('every order from $25K is kept as signed USD in its minute; a line at a box edge adds up to the boxes from that edge, on every bar', () => {
  const recorder = new FootprintRecorder(null, () => T0 + 30 * MIN);
  record(recorder, orders(30));
  const edges = SIZE_EDGES.slice(1, 1 + MAX_CUTS);
  for (const id of ['a:BTC', 'b:BTC']) {
    const { bars } = recorder.query(id, T0, T0 + 30 * MIN, 5 * MIN, 0, edges);
    assert.equal(bars.length, 6);
    for (const bar of bars) {
      assert.ok(bar.stats && bar.over, 'every minute recorded here has statistics and its list');
      edges.forEach((edge, k) => {
        assert.ok(Math.abs(bar.over![2 * k]! - bucketsFrom(bar.stats!.buy, edge)) < 1e-6, `${id} buys from ${edge}`);
        assert.ok(Math.abs(bar.over![2 * k + 1]! - bucketsFrom(bar.stats!.sell, edge)) < 1e-6, `${id} sells from ${edge}`);
      });
    }
  }
  // A line between the edges: the orders themselves decide.
  const all = orders(30).filter(o => o.instrumentId === 'a:BTC'), cut = 75_000;
  const { bars } = recorder.query('a:BTC', T0, T0 + 30 * MIN, 30 * MIN, 0, [cut]);
  assert.ok(Math.abs(bars[0]!.over![0]! - all.filter(o => o.side === 'buy' && o.usd >= cut).reduce((a, o) => a + o.usd, 0)) < 1e-6);
  assert.ok(Math.abs(bars[0]!.over![1]! - all.filter(o => o.side === 'sell' && o.usd >= cut).reduce((a, o) => a + o.usd, 0)) < 1e-6);
  assert.equal(recorder.query('a:BTC', T0, T0 + 30 * MIN, 30 * MIN, 0).bars[0]!.over, undefined, 'no line asked, none drawn');
  assert.ok(sizeBucket(24_999) === 0 && sizeBucket(25_000) === 1, 'the list starts where the second box does');
});

test('the sizes windows carry the lines too, and the bars and windows say nothing of a line where a minute has no list', () => {
  const rows: FootprintMinuteRow[] = [
    // A minute recorded before the lists were kept: statistics, no list.
    { inst: 'a:BTC', t: T0 - 2 * MIN, step: 0.5, bins: [[170_000, 40_000, 0]], stats: { buyN: 1, sellN: 0, buy: [0, 40_000, 0, 0, 0, 0, 0, 0], sell: [0, 0, 0, 0, 0, 0, 0, 0], v: 2 } },
  ];
  const store: FootprintStore = { load: () => rows, save: () => {}, close: () => {} };
  const recorder = new FootprintRecorder(store, () => T0 + 30_000);
  record(recorder, [{ instrumentId: 'a:BTC', side: 'buy', t: T0 + 1_000, usd: 300_000 }, { instrumentId: 'a:BTC', side: 'sell', t: T0 + 2_000, usd: 30_000 }]);
  const now = recorder.sizes(['a:BTC'], [1, 5], [25_000, 250_000]);
  assert.deepEqual(now.windows[0]!.over, [300_000, 30_000, 300_000, 0], 'the open minute has its list');
  assert.equal(now.windows[1]!.over, undefined, 'five minutes reach the minute without a list');
  assert.equal(recorder.query('a:BTC', T0 - 5 * MIN, T0 + MIN, 5 * MIN, 0, [25_000]).bars.find(b => b.t === T0 - 5 * MIN)!.over, undefined);
  // Filled from the prints, the minute answers like any other (the bars' and the windows' figures agree with the boxes again).
  assert.deepEqual(recorder.unknownLists(), { from: T0 - 2 * MIN, to: T0 - MIN });
  const filled = recorder.fillLists(T0 - 10 * MIN, T0, [{ id: 'a:BTC', t: T0 - 2 * MIN + 5_000, side: 'buy', usd: 40_000 }, { id: 'a:BTC', t: T0 - 20 * MIN, side: 'buy', usd: 99_000 }]);
  assert.equal(filled, 1); assert.equal(recorder.unknownLists(), null);
  assert.deepEqual(recorder.sizes(['a:BTC'], [5], [25_000, 250_000]).windows[0]!.over, [340_000, 30_000, 300_000, 0]);
  assert.equal(recorder.fillLists(T0 - 10 * MIN, T0, [{ id: 'a:BTC', t: T0 - 2 * MIN + 6_000, side: 'buy', usd: 70_000 }]), 0, 'a minute that has its list keeps it');
});

test('a minute with no large order shares one empty list, and the first order gives it its own', () => {
  const recorder = new FootprintRecorder(null, () => T0 + 30_000);
  record(recorder, [{ instrumentId: 'a:BTC', side: 'buy', t: T0 + 1_000, usd: 5_000 }, { instrumentId: 'b:BTC', side: 'buy', t: T0 + 1_000, usd: 6_000 }]);
  const saved: FootprintMinuteRow[] = [];
  const store: FootprintStore = { load: () => [], save: rows => saved.push(...rows), close: () => {} };
  const writer = new FootprintRecorder(store, () => T0 + 2 * MIN);
  record(writer, [{ instrumentId: 'a:BTC', side: 'buy', t: T0 + 1_000, usd: 5_000 }, { instrumentId: 'a:BTC', side: 'sell', t: T0 + 2_000, usd: 125_000 }]);
  writer.flush();
  assert.deepEqual(saved[0]!.stats!.big, [-125_000]);
  assert.deepEqual(recorder.sizes(['a:BTC', 'b:BTC'], [1], [25_000]).windows[0]!.over, [0, 0], 'known, and empty');
  assert.doesNotThrow(() => record(recorder, [{ instrumentId: 'b:BTC', side: 'buy', t: T0 + 3_000, usd: 50_000 }]), 'the shared empty list is never written to');
  assert.deepEqual(recorder.sizes(['a:BTC'], [1], [25_000]).windows[0]!.over, [0, 0], 'and another minute\'s order is not in this one\'s list');
});

test('the list is stored as a sixth element that the five-element reading passes over; a list that is not one leaves the minute unknown', () => {
  const stats = { buyN: 2, sellN: 1, buy: [1, 30_000, 0, 0, 0, 0, 0, 0], sell: [0, 0, 0, 120_000, 0, 0, 0, 0], v: 2, big: [30_000, -120_000] };
  const text = statsText(stats);
  assert.deepEqual(JSON.parse(text).slice(0, 5), [2, 1, stats.buy, stats.sell, 2], 'the first five are what older code reads');
  assert.deepEqual(parseStats(text)!.big, [30_000, -120_000]);
  assert.equal(parseStats(statsText({ ...stats, big: undefined }))!.big, undefined, 'none written: not known');
  assert.deepEqual(parseStats(statsText({ ...stats, big: [] }))!.big, [], 'an empty list is known and empty');
  for (const bad of ['"x"', '[1, "two"]', '[0]', '[null]']) {
    const parsed = parseStats(`[2,1,${JSON.stringify(stats.buy)},${JSON.stringify(stats.sell)},2,${bad}]`);
    assert.ok(parsed, `${bad}: the statistics are still read`); assert.equal(parsed!.big, undefined, `${bad}: the list is not`);
  }
});

test('size lines are read from a question within the floor, the most there may be and the largest', () => {
  assert.deepEqual(parseCuts(null, 25_000), []); assert.deepEqual(parseCuts('', 25_000), []);
  assert.deepEqual(parseCuts('25000,75000,2000000', 25_000), [25_000, 75_000, 2_000_000]);
  for (const bad of ['24999', '75000,abc', '1e13', '-1', '25000,50000,75000,100000,125000', 'NaN', 'Infinity']) assert.equal(parseCuts(bad, 25_000), null, bad);
  assert.deepEqual(parseCuts('2500', 2_500), [2_500], 'a coin with a smaller floor has smaller lines');
});

test('the print stream walks a stretch from its store, with the prints it has not written yet', () => {
  const stored: Print[] = [{ t: T0 + 1_000, id: 'a:BTC', side: 'buy', price: 85_000, usd: 40_000 }];
  const store: PrintStore = { load: () => [], save: () => {}, close: () => {}, eachIn: (from, to, take) => { for (const p of stored) if (p.t >= from && p.t < to) take(p); } };
  const stream = new PrintStream(store, () => T0 + MIN);
  stream.ingest([{ instrumentId: 'a:BTC', tradeId: 'n1', side: 'sell', price: 85_000, notionalUsd: 60_000, sourceTimestamp: T0 + 2_000 }]);
  const seen: number[] = []; stream.eachIn(T0, T0 + MIN, p => seen.push(p.side === 'buy' ? p.usd : -p.usd));
  assert.deepEqual(seen.sort((a, b) => a - b), [-60_000, 40_000]);
});

async function withServer(run: (ctx: { base: string; v2: ReturnType<typeof installV2> }) => Promise<void>): Promise<void> {
  const app = createLocalServer({ history: new HistoryStore({ filePath: ':memory:' }), quota: new QuotaLedger({ filePath: ':memory:' }), persistFixture: false });
  const v2 = installV2(app, { dataDir: '', persist: false, liveMs: 50, heartbeatMs: 500 });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  try { await run({ base: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`, v2 }); } finally {
    v2.close(); app.server.closeAllConnections(); await new Promise<void>(resolve => app.server.close(() => resolve())); await app.close();
  }
}

test('/api/v2/footprint and /api/v2/sizes draw the lines asked for, and refuse lines under the floor', async () => {
  await withServer(async ({ base, v2 }) => {
    const into = Date.now() % MIN;
    if (into > MIN - 5_000) await new Promise<void>(resolve => setTimeout(resolve, MIN - into + 100));
    const now = Date.now();
    record(v2.footprint, [{ instrumentId: 'x:BTC', side: 'buy', t: now, usd: 80_000 }, { instrumentId: 'x:BTC', side: 'sell', t: now, usd: 2_500_000 }, { instrumentId: 'x:BTC', side: 'buy', t: now, usd: 9_000 }]);
    const sizes = await (await fetch(`${base}/api/v2/sizes?inst=x:BTC&minutes=1&cuts=75000,2000000`)).json();
    assert.deepEqual(parseSizes(sizes, [1], 2)!.windows[0]!.over, [80_000, 2_500_000, 0, 2_500_000]);
    const fp = await (await fetch(`${base}/api/v2/footprint?inst=x:BTC&tf=1m&from=${now - MIN}&to=${now + MIN}&cuts=75000`)).json() as { bars: { over?: number[] }[] };
    assert.deepEqual(fp.bars.at(-1)!.over, [80_000, 2_500_000]);
    assert.equal(parseSizes(sizes, [1], 0)!.windows[0]!.over, undefined, 'a reader that asked for none keeps none');
    for (const query of ['sizes?inst=x:BTC&minutes=1&cuts=10000', 'sizes?inst=x:BTC&minutes=1&cuts=x', `footprint?inst=x:BTC&tf=1m&cuts=${'30000,'.repeat(5)}30000`]) {
      const r = await fetch(`${base}/api/v2/${query}`); assert.equal(r.status, 400, query);
    }
  });
});
