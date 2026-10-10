import test from 'node:test';
import assert from 'node:assert/strict';
import { BAR_STATS, DEFAULT_STAT_OPTIONS, PRESETS, diagonalImbalances, enabledStats, rowScale, stackedRuns, stackedZones, statDef, strength, type StatInput, type StatOptions } from '../src/app/panes/bar-stats.ts';
import type { Bar } from '../src/app/panes/footprint.ts';
import { readStatOptions } from '../src/app/stat-options.ts';
import type { CandleRow, OiBar } from '../src/app/store.ts';

const MIN = 60_000;
const bar = (t: number, rows: [number, number, number][], stats?: Bar['stats']): Bar => ({ t, rows, buyUsd: rows.reduce((s, r) => s + r[1], 0), sellUsd: rows.reduce((s, r) => s + r[2], 0), ...(stats ? { stats } : {}) });
const zeros = () => [0, 0, 0, 0, 0, 0, 0, 0];
const tradeStats = (buyN: number, sellN: number, buy: number[], sell: number[]) => ({ buyN, sellN, buy, sell });
const bars = [
  bar(0, [[100, 30, 10], [105, 5, 20]], tradeStats(2, 1, [100, 0, 0, 0, 0, 0, 0, 5_000_000], [0, 0, 60_000, 0, 0, 0, 0, 0])),
  bar(MIN, [[100, 0, 0]]),
  bar(2 * MIN, [[110, 40, 40], [115, 10, 2]], tradeStats(1, 1, [0, 0, 0, 0, 0, 80_000, 0, 0], [0, 25_000, 0, 0, 0, 0, 0, 0])),
];
const candles = new Map<number, CandleRow>([[0, [0, 100, 112, 99, 105, 55, 1]], [2 * MIN, [2 * MIN, 110, 118, 108, 116, 92, 1]]]);
const oi = new Map<number, OiBar>([[0, [0, 1000, 1010, 990, 1005]], [2 * MIN, [2 * MIN, 1005, 1020, 1000, 1002]]]);
const input = (options: Partial<StatOptions> = {}): StatInput => ({ bars, step: 5, candles, oi, options: { ...DEFAULT_STAT_OPTIONS, ...options } });
const compute = (id: string, options: Partial<StatOptions> = {}) => statDef(id)!.compute(input(options));

test('volume, delta, cumulative delta and the buy/sell split follow the executions of each bar', () => {
  assert.deepEqual(compute('vol'), [65, 0, 92]);
  assert.deepEqual(compute('delta'), [5, 0, 8]);
  assert.deepEqual(compute('cvd'), [5, 5, 13], 'running sum over the bars given');
  assert.deepEqual(compute('buyVol'), [35, 0, 50]);
  assert.deepEqual(compute('sellVol'), [30, 0, 42]);
  const pct = compute('deltaPct');
  assert.ok(Math.abs(pct[0]! - 5 / 65 * 100) < 1e-9);
  assert.equal(pct[1], null, 'no executions, no share');
});

test('row extremes and the point of control come from the price rows', () => {
  assert.deepEqual(compute('maxBuy'), [30, 0, 40]);
  assert.deepEqual(compute('maxSell'), [20, 0, 40]);
  assert.deepEqual(compute('poc'), [102.5, 102.5, 112.5], 'row 100 (40) beats 105 (25); the empty bar falls on its only row; 110 (80) beats 115 (12)');
});

test('diagonal imbalances compare a level with the opposite side one row away and stack when adjacent', () => {
  const rows: [number, number, number][] = [[100, 5, 90], [105, 20, 10], [110, 90, 5], [115, 100, 4]];
  const found = diagonalImbalances(rows, 5, { imbRatio: 3, imbMinUsd: 0 });
  assert.deepEqual(found, [{ low: 100, side: 'sell', ratio: 4.5 }, { low: 110, side: 'buy', ratio: 9 }, { low: 115, side: 'buy', ratio: 20 }], 'sell 90 vs buy 20 above; buy 90 vs sell 10 below; buy 100 vs sell 5 below');
  assert.equal(stackedRuns(found, 5, 2), 1, 'two adjacent buy rows');
  assert.equal(stackedRuns(found, 5, 3), 0);
  assert.deepEqual(stackedZones(found, 5, 2), [{ side: 'buy', low: 110, high: 120 }], 'the run as a price span, from its lowest row\'s bottom to its highest row\'s top');
  assert.deepEqual(diagonalImbalances(rows, 5, { imbRatio: 3, imbMinUsd: 95 }), [{ low: 115, side: 'buy', ratio: 20 }], 'minimum size filters small levels');
  // An empty row inside the candle counts only with imbZeros; past the candle's top or bottom there is nothing to compare with.
  const gap: [number, number, number][] = [[100, 10, 40], [110, 30, 5]];
  assert.deepEqual(diagonalImbalances(gap, 5, { imbRatio: 3, imbMinUsd: 0 }), []);
  assert.deepEqual(diagonalImbalances(gap, 5, { imbRatio: 3, imbMinUsd: 0, imbZeros: true }), [{ low: 100, side: 'sell', ratio: Infinity }, { low: 110, side: 'buy', ratio: Infinity }]);
  assert.deepEqual(diagonalImbalances(rows, 5, { imbRatio: 30, imbMinUsd: 0 }), [], 'a higher ratio finds none');
  assert.deepEqual(diagonalImbalances([[100, 50, 0], [110, 0, 50]], 5, { imbRatio: 3, imbMinUsd: 0 }), [], 'rows two steps apart are not neighbours');
  assert.deepEqual(compute('imbalances', { imbRatio: 1.2 }).map(v => typeof v), ['number', 'number', 'number']);
});

test('trade stats exist only for bars recorded with them and size buckets split retail from whales', () => {
  assert.deepEqual(compute('trades'), [3, null, 2]);
  assert.deepEqual(compute('buys'), [2, null, 1]);
  assert.deepEqual(compute('sells'), [1, null, 1]);
  assert.deepEqual(compute('avgTrade'), [(100 + 5_000_000 + 60_000) / 3, null, 105_000 / 2]);
  assert.deepEqual(compute('deltaRetail'), [100 - 60_000, null, -25_000], 'under $100K by default: the first three boxes');
  assert.deepEqual(compute('deltaWhales'), [5_000_000, null, 80_000], 'from $500K by default: the last three');
  assert.deepEqual(compute('deltaRetail', { retailUsd: 50_000 }), [100, null, -25_000], 'the retail size moves with the option');
  assert.deepEqual(compute('deltaWhales', { whaleUsd: 5_000_000 }), [5_000_000, null, 0]);
  assert.deepEqual(compute('cvdRetail'), [-59_900, null, -84_900], 'running sum skips bars without stats');
  assert.deepEqual(compute('cvdWhales'), [5_000_000, null, 5_080_000]);
  assert.equal(zeros().length, 8);
});

test('a size between the box edges is exact where the bars carry its line, and taken at the nearest edge (with ≈) where they do not', () => {
  // The bars were loaded with lines at $75K and $2M: their sums are the orders themselves.
  const lined = bars.map((b, i) => i === 1 ? b : { ...b, over: i === 0 ? [5_000_000, 0, 5_000_000, 0] : [80_000, 0, 0, 0] });
  const options = { ...DEFAULT_STAT_OPTIONS, retailUsd: 75_000, whaleUsd: 2_000_000 };
  const at = (id: string, cuts?: number[], list = lined) => { const i: StatInput = { bars: list, step: 5, candles, oi, options, ...(cuts ? { cuts } : {}) }; return { values: statDef(id)!.compute(i), approx: statDef(id)!.approx?.(i) ?? false }; };
  assert.deepEqual(at('deltaRetail', [75_000, 2_000_000]), { values: [100 - 60_000, null, -25_000], approx: false }, 'retail: everything less the orders from $75K');
  assert.deepEqual(at('deltaWhales', [75_000, 2_000_000]), { values: [5_000_000, null, 0], approx: false });
  // Without the lines (an older server): the boxes at the nearest edge, $100K and $1M, and the rows say they are about.
  assert.deepEqual(at('deltaRetail', undefined, bars), { values: [100 - 60_000, null, -25_000], approx: true });
  assert.deepEqual(at('deltaWhales', undefined, bars), { values: [5_000_000, null, 0], approx: true });
  assert.equal(at('deltaRetail', [50_000, 2_000_000]).approx, true, 'lines for other sizes are not this one\'s');
  assert.equal(statDef('delta')!.approx, undefined, 'a statistic of the whole bar is never about');
  // At a box edge the boxes are exact, with or without the lines.
  const edge = { ...DEFAULT_STAT_OPTIONS, retailUsd: 100_000, whaleUsd: 1_000_000 };
  assert.equal(statDef('cvdRetail')!.approx!({ bars, step: 5, candles, oi, options: edge }), false);
});

test('candle and open-interest stats read the bar of the same period, in the unit chosen', () => {
  assert.deepEqual(compute('range'), [13, null, 10]);
  assert.deepEqual(compute('oiChange'), [null, null, -3], 'base coin by default; the first bar has no bar before it to be compared with');
  assert.deepEqual(compute('oiChange', { oiUnits: 'usd' }), [null, null, -3 * 116], 'change times the bar close');
});

test('open-interest change is the step from the close of the bar before, so a bar holding one reading still shows that it moved', () => {
  const points = new Map<number, OiBar>([[0, [0, 100, 100, 100, 100]], [MIN, [MIN, 250, 250, 250, 250]]]);   // one reading per bar: open = close
  const found = statDef('oiChange')!.compute({ bars: bars.slice(0, 2), step: 5, candles, oi: points, options: { ...DEFAULT_STAT_OPTIONS } });
  assert.deepEqual(found, [null, 150], 'the pane shows 150 here; close minus open was 0');
});

test('configuration helpers: presets, order, unknown ids', () => {
  assert.deepEqual(PRESETS.default, ['vol', 'delta', 'cvd']);
  assert.deepEqual(PRESETS.none, []);
  assert.equal(PRESETS.all.length, BAR_STATS.length);
  assert.deepEqual(enabledStats(['delta', 'nope', 'vol', 'delta']).map(d => d.id), ['delta', 'vol']);
  assert.equal(new Set(BAR_STATS.map(d => d.id)).size, BAR_STATS.length, 'ids are unique');
  for (const def of BAR_STATS) assert.equal(typeof def.format(12345.6), 'string', def.id);
  for (const id of PRESETS.default) assert.ok(statDef(id), id);
});

test('colour scale: log between the visible 2nd and 99th percentile, so one outlier does not flatten a row', () => {
  const def = statDef('delta')!;
  const values = [...Array.from({ length: 999 }, (_, i) => i + 1), 1e9];
  const scale = rowScale(def, values)!;
  assert.ok(scale.hi < 1_000 && scale.hi > 900, `p99 ignores the outlier (hi ${scale.hi})`);
  assert.equal(strength(def, 1e9, scale), 1, 'the outlier saturates');
  assert.ok(strength(def, 500, scale) > 0.8 && strength(def, 500, scale) < 1, 'ordinary bars still use the range');
  assert.equal(strength(def, 1, scale), 0, 'at or below the 2nd percentile nothing is shaded');
  assert.equal(strength(def, -500, scale), strength(def, 500, scale), 'the sign does not change the strength');
  assert.equal(rowScale(statDef('poc')!, [1, 2]), null, 'plain stats have no scale');
  assert.equal(rowScale(def, [0, null, undefined]), null, 'nothing to scale');
  const share = statDef('deltaPct')!;
  assert.equal(strength(share, 0, rowScale(share, [-100, -50, 50, 100])), 0);
});

test('bar statistics options from storage or a file: each within what the settings allow, else its default', () => {
  assert.deepEqual(readStatOptions(undefined), DEFAULT_STAT_OPTIONS);
  const good = { imbRatio: 2.5, imbMinUsd: 10_000, stackedN: 4, imbZeros: true, retailUsd: 75_000, whaleUsd: 2_000_000, oiUnits: 'usd', cells: 'text' } as const;
  assert.deepEqual(readStatOptions(good), good);
  const bad = readStatOptions({ imbRatio: 0.5, imbMinUsd: -1, stackedN: 2.5, imbZeros: 'yes', retailUsd: 9, whaleUsd: -1, oiUnits: 'eur', cells: 'neon', extra: 1 });
  assert.deepEqual(bad, DEFAULT_STAT_OPTIONS);
  const crossed = readStatOptions({ retailUsd: 1_000_000, whaleUsd: 100_000 });
  assert.deepEqual([crossed.retailUsd, crossed.whaleUsd], [100_000, 500_000], 'whales may not start under retail');
  assert.deepEqual([readStatOptions({ retailUsd: 25_000, whaleUsd: 25_000 }).retailUsd, readStatOptions({ retailUsd: 25_000, whaleUsd: 25_000 }).whaleUsd], [25_000, 25_000], 'the floor, and the two sizes the same');
  // A save from before the sizes were free holds box numbers: retail up to box 1 is under $50K, whales from box 6 start at $1M.
  const old = readStatOptions({ retailMax: 1, whaleMin: 6 });
  assert.deepEqual([old.retailUsd, old.whaleUsd], [50_000, 1_000_000]);
  assert.deepEqual([readStatOptions({ retailMax: 7, whaleMin: 0 }).retailUsd, readStatOptions({ retailMax: 7, whaleMin: 0 }).whaleUsd], [100_000, 500_000], 'box numbers with no such edge are the defaults');
  assert.equal(readStatOptions({ stackedN: 1 }).stackedN, 3);
});
