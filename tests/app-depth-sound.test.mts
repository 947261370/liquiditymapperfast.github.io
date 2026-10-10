import test from 'node:test';
import assert from 'node:assert/strict';
import { DEPTH_MIN_BASELINE, DepthWatch, depthMinutes, percentile, type DepthMinute } from '../src/app/sound/depth-watch.ts';
import { Alerts, depthIds, type Player } from '../src/app/sound/alerts.ts';
import { DEFAULT_PANEL_SOUNDS, readSounds, type Note } from '../src/app/sound/rules.ts';
import { FlowBook } from '../src/app/flow-book.ts';
import { initialState } from '../src/app/store.ts';
import type { ColumnSet, ColumnsFrame } from '../src/app/wire.ts';
import { startReplay, stopReplay } from '../src/app/replay/clock.ts';

const MIN = 60_000, HOUR = 3_600_000;
const T0 = Date.UTC(2026, 9, 10, 0, 0, 0);
/** A minute whose two instruments hold `bid` and `ask` between them (half each), or only `a` when `bOut`. */
const minute = (t: number, bid: number, ask: number, bOut = false): DepthMinute => ({ t,
  bid: new Map(bOut ? [['a', bid]] : [['a', bid / 2], ['b', bid / 2]]), ask: new Map(bOut ? [['a', ask]] : [['a', ask / 2], ['b', ask / 2]]) });
/** An ordinary minute: a balance within a few percent, a different one each minute. */
const ordinary = (k: number): DepthMinute => { const tilt = ((k * 37) % 50 - 25) / 1_000; return minute(T0 + k * MIN, 1_000 * (1 + tilt), 1_000 * (1 - tilt)); };

test('percentiles are by nearest rank', () => {
  const sorted = Array.from({ length: 100 }, (_, i) => i + 1);
  assert.equal(percentile(sorted, 99), 99); assert.equal(percentile(sorted, 50), 50); assert.equal(percentile(sorted, 100), 100); assert.equal(percentile([7], 99), 7);
});

test('an extreme minute sounds once for its side, and not again until the balance has come back to its usual', () => {
  const w = new DepthWatch(), opts = { pct: 99, hours: 6 };
  w.add(Array.from({ length: 120 }, (_, k) => ordinary(k)), 0);
  for (let k = 60; k < 120; k++) assert.equal(w.judge(T0 + k * MIN, opts), null, `ordinary minute ${k}`);
  w.add([minute(T0 + 120 * MIN, 1_500, 500)], 0);
  const s = w.judge(T0 + 120 * MIN, opts)!;
  assert.equal(s.side, 'buy'); assert.equal(s.share, 0.5); assert.ok(s.threshold < 0.05, `${s.threshold}`);
  assert.equal(s.minutes, 120); assert.ok(Math.abs(s.usualBid - 1_000) < 30 && Math.abs(s.usualAsk - 1_000) < 30);
  w.add([minute(T0 + 121 * MIN, 1_600, 400)], 0);
  assert.equal(w.judge(T0 + 121 * MIN, opts), null, 'the same episode');
  w.add([minute(T0 + 122 * MIN, 1_000, 1_000)], 0);
  assert.equal(w.judge(T0 + 122 * MIN, opts), null, 'back to usual: armed again');
  w.add([minute(T0 + 123 * MIN, 450, 1_550)], 0);
  assert.equal(w.judge(T0 + 123 * MIN, opts)?.side, 'sell');
});

test('nothing is judged before an hour of complete minutes; a minute missing a usual venue is a gap, neither judged nor counted', () => {
  const short = new DepthWatch();
  short.add([...Array.from({ length: DEPTH_MIN_BASELINE - 1 }, (_, k) => ordinary(k)), minute(T0 + (DEPTH_MIN_BASELINE - 1) * MIN, 1_900, 100)], 0);
  assert.equal(short.judge(T0 + (DEPTH_MIN_BASELINE - 1) * MIN, { pct: 99, hours: 6 }), null, 'warm-up');
  const w = new DepthWatch();
  // b drops out for a minute: its half of the book goes with it, which is the recording, not the market.
  w.add([...Array.from({ length: 120 }, (_, k) => ordinary(k)), minute(T0 + 120 * MIN, 1_000, 1_000, true)], 0);
  assert.equal(w.judge(T0 + 120 * MIN, { pct: 99, hours: 6 }), null);
  // Out for most of the baseline, b is no longer one of the usual venues, and a's own balance is judged.
  const gone = new DepthWatch();
  gone.add([...Array.from({ length: 30 }, (_, k) => ordinary(k)), ...Array.from({ length: 90 }, (_, k) => { const m = ordinary(30 + k); return minute(m.t, [...m.bid.values()].reduce((a, b) => a + b, 0), [...m.ask.values()].reduce((a, b) => a + b, 0), true); }),
    minute(T0 + 120 * MIN, 1_800, 200, true)], 0);
  assert.equal(gone.judge(T0 + 120 * MIN, { pct: 99, hours: 6 })?.side, 'buy');
  // Minutes before the baseline's hours do not count.
  const old = new DepthWatch();
  old.add([...Array.from({ length: 120 }, (_, k) => ordinary(k)), minute(T0 + 300 * MIN, 1_800, 200)], 0);
  assert.equal(old.judge(T0 + 300 * MIN, { pct: 99, hours: 2 }), null, 'only 0 minutes of the last two hours are held');
});

/** One-minute columns of instruments over [from, to): a bid at 99 and an ask at 101 on a grid of 1, sized by `book(id, t)`. */
function frame(ids: readonly string[], from: number, to: number, book: (id: string, t: number) => { bid: number; ask: number } | null): ColumnsFrame {
  const instruments: ColumnSet[] = ids.map(id => {
    const times: number[] = [], counts: number[] = [], samples: number[] = [], bins: number[] = [], bid: number[] = [], ask: number[] = [];
    for (let t = from; t < to; t += MIN) { const b = book(id, t); if (!b) continue; times.push(t); counts.push(2); samples.push(12); bins.push(99, 101); bid.push(b.bid, 0); ask.push(0, b.ask); }
    return { id, step: 1, times, counts, samples, bins: Int32Array.from(bins), bid: Float32Array.from(bid), ask: Float32Array.from(ask) };
  });
  return { from, to, stepMs: MIN, instruments };
}

test('a frame of columns becomes minutes of band totals, an instrument with no column that minute left out', () => {
  const f = frame(['a', 'b'], T0, T0 + 3 * MIN, (id, t) => id === 'b' && t === T0 + MIN ? null : { bid: 100, ask: 300 });
  const ms = depthMinutes(f, T0, T0 + 3 * MIN, 0.2);
  assert.deepEqual(ms.map(m => [m.t - T0, [...m.bid.keys()].join(','), m.bid.get('a'), m.ask.get('a')]), [[0, 'a,b', 100, 300], [MIN, 'a', 100, 300], [2 * MIN, 'a,b', 100, 300]]);
  assert.deepEqual(depthMinutes(frame(['a'], T0, T0 + MIN, () => ({ bid: 100, ask: 300 })), T0, T0 + MIN, 0.001).map(m => [m.bid.get('a'), m.ask.get('a')]), [[0, 0]], 'outside a 0.1 % band of 100');
});

class FakePlayer implements Player { played: Note[][] = []; play(notes: readonly Note[]): boolean { this.played.push([...notes]); return true; } async unlock(): Promise<void> {} }
const settle = () => new Promise(r => setImmediate(r));

test('the depth sound loads its hours an hour at a time, then reads each committed minute and sounds on a fresh extreme one', async () => {
  const state = initialState();
  state.markets = [{ instrumentId: 'a:BTC', venue: 'a', marketType: 'perpetual' }, { instrumentId: 'b:BTC', venue: 'b', marketType: 'perpetual' }, { instrumentId: 'c:BTC', venue: 'c', marketType: 'perpetual' }];
  state.disabledVenues = ['c'];
  state.sounds = readSounds({ on: true, volume: 1, panels: { ...DEFAULT_PANEL_SOUNDS, depthPane: { extreme: true, range: 0.2, pct: 99, hours: 2 } } });
  const extreme = T0 + 2 * HOUR + 5 * MIN, asked: [string, number, number][] = [];
  const reader = (ids: string[], from: number, to: number): Promise<ColumnsFrame> => {
    asked.push([ids.join(','), from - T0, to - T0]);
    return Promise.resolve(frame(ids, from, to, (_, t) => t === extreme ? { bid: 900, ask: 100 } : { bid: 500 + ((t / MIN) * 37) % 20, ask: 500 }));
  };
  let now = T0 + 2 * HOUR + 20_000;
  const player = new FakePlayer(), alerts = new Alerts({ state }, new FlowBook(), player, () => now, undefined, reader);
  for (let i = 0; i < 4; i++) { alerts.tick(now); await settle(); }
  assert.deepEqual(asked, [['a:BTC,b:BTC', 0, HOUR], ['a:BTC,b:BTC', HOUR, 2 * HOUR]], 'two hours, an hour per question, the switched-off venue left out');
  assert.deepEqual(alerts.depthState, { minutes: 120, loading: false });
  assert.equal(player.played.length, 0, 'the hours loaded are history');
  for (const minute of [0, 1, 2, 3, 4, 5]) { now = T0 + 2 * HOUR + (minute + 1) * MIN + 15_000; alerts.tick(now); await settle(); alerts.tick(now); await settle(); }
  assert.deepEqual(asked.slice(2).map(a => (a[2] - a[1]) / MIN), [1, 1, 1, 1, 1, 1], 'then a minute at a time, each once');
  assert.equal(player.played.length, 1);
  assert.equal(alerts.log[0]!.kind, 'depth-extreme'); assert.equal(alerts.log[0]!.side, 'buy'); assert.equal(alerts.log[0]!.panel, 'depthPane');
  assert.match(alerts.log[0]!.text, /within 20%.*99 %.*2 h; bids \+\d+%, asks -\d+%/);
  // Switched off, it forgets everything and asks nothing.
  state.sounds = readSounds({ ...state.sounds, panels: { ...state.sounds.panels, depthPane: { ...state.sounds.panels.depthPane, extreme: false } } });
  const before = asked.length; now += 5 * MIN; alerts.tick(now); await settle();
  assert.equal(asked.length, before); assert.equal(alerts.depthState, null);
});

/** A depth sound over two venues and the last two hours, read through `book`; `hold` keeps an answer back until `release` is called. */
function depthRig(book: (t: number) => { bid: number; ask: number }) {
  const state = initialState();
  state.markets = [{ instrumentId: 'a:BTC', venue: 'a', marketType: 'perpetual' }, { instrumentId: 'b:BTC', venue: 'b', marketType: 'perpetual' }];
  state.sounds = readSounds({ on: true, volume: 1, panels: { ...DEFAULT_PANEL_SOUNDS, depthPane: { extreme: true, range: 0.2, pct: 99, hours: 2 } } });
  const rig = { state, now: T0 + 2 * HOUR + 20_000, hold: false, release: () => {}, asked: [] as [number, number][], player: new FakePlayer(), alerts: null as unknown as Alerts };
  rig.alerts = new Alerts({ state }, new FlowBook(), rig.player, () => rig.now, undefined, (ids, from, to) => {
    rig.asked.push([from, to]);
    const answer = frame(ids, from, to, (_, t) => book(t));
    return rig.hold ? new Promise(resolve => { rig.release = () => resolve(answer); }) : Promise.resolve(answer);
  });
  return rig;
}
/** An ordinary balance, a different one each minute: bids 0 to 19 above the asks' 500. */
const usual = (t: number) => ({ bid: 500 + ((t / MIN) * 37) % 20, ask: 500 });
async function load(rig: ReturnType<typeof depthRig>): Promise<void> { for (let i = 0; i < 3; i++) { rig.alerts.tick(rig.now); await settle(); } }

test('an answer that comes after a replay began, or after the sound was switched off, plays nothing', async () => {
  const extreme = T0 + 2 * HOUR;
  for (const interrupt of ['replay', 'off'] as const) {
    const rig = depthRig(t => t === extreme ? { bid: 900, ask: 100 } : usual(t));
    await load(rig);
    rig.now = T0 + 2 * HOUR + MIN + 15_000; rig.hold = true; rig.alerts.tick(rig.now); await settle();
    assert.deepEqual(rig.asked.at(-1), [extreme, extreme + MIN], 'the extreme minute is being asked for');
    if (interrupt === 'replay') startReplay(T0); else rig.state.sounds = readSounds({ ...rig.state.sounds, panels: { ...rig.state.sounds.panels, depthPane: { ...rig.state.sounds.panels.depthPane, extreme: false } } });
    try { rig.release(); await settle(); } finally { stopReplay(); }
    assert.equal(rig.player.played.length, 0, interrupt); assert.equal(rig.alerts.log.length, 0, interrupt);
  }
});

test('after a pause of hours the minutes caught up still re-arm the watch, so the next extreme sounds', async () => {
  // An extreme at 2:00, back to usual for two hours, then a little above usual (not enough to re-arm) and a fresh extreme at 4:10.
  const first = T0 + 2 * HOUR, second = T0 + 4 * HOUR + 10 * MIN;
  const rig = depthRig(t => t === first || t === second ? { bid: 900, ask: 100 } : t > T0 + 4 * HOUR ? { bid: 515, ask: 500 } : usual(t));
  await load(rig);
  rig.now = first + MIN + 15_000; rig.alerts.tick(rig.now); await settle();
  assert.equal(rig.player.played.length, 1, 'the first extreme');
  // The tab sleeps until 4:11: three questions catch up, the last one only ten minutes long.
  rig.now = second + MIN + 15_000;
  for (let i = 0; i < 4; i++) { rig.alerts.tick(rig.now); await settle(); }
  assert.deepEqual(rig.asked.slice(-3).map(([from, to]) => (to - from) / MIN), [60, 60, 10]);
  assert.equal(rig.player.played.length, 2, 'the second extreme sounds: the usual hours in between re-armed it');
  assert.equal(rig.alerts.log[1]!.side, 'buy');
});

test('catching up judges each minute against the whole of its hours, so an episode that never came back sounds once', async () => {
  // Two hours of history whose older half sits lower than its newer half, an extreme, then a hundred minutes a little above the usual
  // and rising (above the median of the two hours before each of them, below their 99th percentile), then a second extreme: one episode.
  // Judged against only the newer half, the first of those minutes looked usual and re-armed the watch (Codex review of 5a3e74b).
  const level = (n: number) => n / 1_000;
  const shareAt = (i: number): number => i < 2 ? level(19) : i < 60 ? level(5 + i % 5) : i < 120 ? level(13 + (i * 3) % 7) : i === 120 || i === 221 ? 0.8 : (1_453 + 3 * (i - 120)) / 100_000;
  const rig = depthRig(t => { const s = shareAt((t - T0) / MIN); return { bid: 500 * (1 + s) / (1 - s), ask: 500 }; });
  await load(rig);
  rig.now = T0 + 121 * MIN + 15_000; rig.alerts.tick(rig.now); await settle();
  assert.equal(rig.player.played.length, 1, 'the first extreme');
  rig.now = T0 + 222 * MIN + 15_000;
  for (let i = 0; i < 3; i++) { rig.alerts.tick(rig.now); await settle(); }
  assert.deepEqual(rig.asked.slice(-2).map(([from, to]) => (to - from) / MIN), [60, 41]);
  assert.equal(rig.player.played.length, 1, 'no minute came back to its usual, so the second extreme is the same episode');
  assert.equal(rig.alerts.depthState?.minutes, 121, 'the hours kept are the baseline of the next minute');
});

test('a minute judged long after it ended does not sound', async () => {
  const state = initialState();
  state.markets = [{ instrumentId: 'a:BTC', venue: 'a', marketType: 'perpetual' }];
  state.sounds = readSounds({ on: true, volume: 1, panels: { ...DEFAULT_PANEL_SOUNDS, depthPane: { extreme: true, range: 0.2, pct: 99, hours: 2 } } });
  let now = T0 + 2 * HOUR + 20_000;
  const late = new Alerts({ state }, new FlowBook(), new FakePlayer(), () => now, undefined, (ids, from, to) => {
    const answer = frame(ids, from, to, (_, t) => t === T0 + 2 * HOUR ? { bid: 900, ask: 100 } : { bid: 500 + ((t / MIN) * 37) % 20, ask: 500 });
    return new Promise(resolve => { now += 3 * MIN; resolve(answer); });   // the answer takes three minutes
  });
  for (let i = 0; i < 3; i++) { late.tick(now); await settle(); }
  now = T0 + 2 * HOUR + MIN + 15_000; late.tick(now); await settle();
  assert.equal(late.log.length, 0);
});

test('the instruments are the enabled markets inside the filter, whether or not their books are in the feed', () => {
  const s = { markets: [{ instrumentId: 'b:X', venue: 'b', marketType: 'perpetual' }, { instrumentId: 'a:X', venue: 'a', marketType: 'perpetual' }, { instrumentId: 'aspot:X', venue: 'aspot', marketType: 'spot' }, { id: 'c:X', marketType: 'perpetual' }], disabledVenues: ['c'], scope: 'perp' as const };
  assert.deepEqual(depthIds(s), ['a:X', 'b:X']);
  assert.deepEqual(depthIds({ ...s, scope: 'all', disabledVenues: [] }), ['a:X', 'aspot:X', 'b:X', 'c:X']);
});
