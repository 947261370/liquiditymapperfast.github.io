import test from 'node:test';
import assert from 'node:assert/strict';
import { SIZE_EDGES } from '../src/shared/footprint.ts';
import { SIZE_FLOOR_USD, SIZE_MAX_USD, COMMON_SIZES, atBoxEdge, linesToAsk, overFromBoxes, parseSize, readSize, sizeFromBox, sizeText, takeSize } from '../src/app/sizes.ts';

test('a size is read as people type it, in either habit of commas and dots', () => {
  const cases: [string, number | null][] = [
    ['100k', 100_000], ['100K', 100_000], ['2.5M', 2_500_000], ['2,5m', 2_500_000], ['1,5M', 1_500_000], ['1b', 1e9], ['0.75m', 750_000], ['.5M', 500_000],
    ['250000', 250_000], ['$250,000', 250_000], ['250.000', 250_000], ['250 000', 250_000], ['1_000_000', 1_000_000], ['1.500.000', 1_500_000], ['1,500,000', 1_500_000],
    ['1,250.5', 1_250.5], ['1.250,5', 1_250.5], ['  75k ', 75_000], ['$ 75k', 75_000], ['12.5', 12.5], ['12,5', 12.5],
    ['', null], ['k', null], ['abc', null], ['1..5m', null], ['1,5,0', null], ['0', null], ['-5k', null], ['1e6', null], ['5x', null], ['1.2.3', null], ['10kk', null],
  ];
  for (const [text, want] of cases) assert.equal(parseSize(text), want, JSON.stringify(text));
});

test('a typed size is taken, held at the least or the most with the reason, or refused; a filter that may be off takes 0', () => {
  const rule = { min: 25_000, max: 1e10 };
  assert.deepEqual(takeSize('75k', 100_000, rule), { value: 75_000, why: null });
  assert.deepEqual(takeSize('10k', 100_000, rule), { value: 25_000, why: 'low' });
  assert.deepEqual(takeSize('20B', 100_000, rule), { value: 1e10, why: 'high' });
  assert.deepEqual(takeSize('lots', 100_000, rule), { value: 100_000, why: 'bad' }, 'not a size: the value stays');
  assert.deepEqual(takeSize('', 100_000, rule), { value: 100_000, why: 'bad' }, 'an empty box is not none unless the size may be off');
  const filter = { min: 1, none: true };
  for (const off of ['', '0', '$0', '0.0', ' any ', 'ANY']) assert.deepEqual(takeSize(off, 50_000, filter, 'any'), { value: 0, why: null }, JSON.stringify(off));
  assert.deepEqual(takeSize('2.5M', 0, filter, 'any'), { value: 2_500_000, why: null }); assert.deepEqual(takeSize('0.5', 0, filter, 'any'), { value: 1, why: 'low' });
});

test('a size is written with the digits it was set with, so the box shows what was typed', () => {
  assert.deepEqual([25_000, 75_000, 1_000_000, 1_250_000, 2_500_000, 123_456, 1e9, 250, 2.5].map(sizeText), ['25K', '75K', '1M', '1.25M', '2.5M', '123.456K', '1B', '250', '2.5']);
  for (const v of [75_000, 1_250_000, 123_456, 33_333_000]) assert.equal(parseSize(sizeText(v)), v, `${v} reads back`);
});

test('a saved size is a dollar size from the floor to the largest, and a size saved as a box number moves to that box\'s edge', () => {
  assert.equal(SIZE_FLOOR_USD, 25_000); assert.ok(COMMON_SIZES.every(s => s >= SIZE_FLOOR_USD && s <= SIZE_MAX_USD));
  assert.equal(readSize(75_000), 75_000); assert.equal(readSize(25_000), 25_000); assert.equal(readSize(24_999), null); assert.equal(readSize(2e10), null);
  assert.equal(readSize('75000'), null); assert.equal(readSize(NaN), null); assert.equal(readSize(Infinity), null);
  // retail "up to box i" is everything under the next box's edge; whales "from box i" start at its edge
  assert.equal(sizeFromBox(2, 1), 100_000); assert.equal(sizeFromBox(0, 1), 25_000); assert.equal(sizeFromBox(6, 1), 5_000_000); assert.equal(sizeFromBox(7, 1), null);
  assert.equal(sizeFromBox(5, 0), 500_000); assert.equal(sizeFromBox(7, 0), 5_000_000); assert.equal(sizeFromBox(0, 0), null, 'from nothing is not a line');
  assert.equal(sizeFromBox(1.5, 0), null); assert.equal(sizeFromBox('2', 1), null); assert.equal(sizeFromBox(-1, 1), null);
});

test('from the boxes alone a line is exact at a box edge and otherwise at the nearest edge, nearest by ratio', () => {
  const buy = SIZE_EDGES.map((_, i) => i + 1), sell = SIZE_EDGES.map((_, i) => 10 * (i + 1));
  const from = (i: number, v: number[]) => v.slice(i).reduce((a, b) => a + b, 0);
  for (let i = 1; i < SIZE_EDGES.length; i++) assert.deepEqual(overFromBoxes(buy, sell, SIZE_EDGES[i]!), { buy: from(i, buy), sell: from(i, sell), exact: true, edge: SIZE_EDGES[i] }, `edge ${i}`);
  assert.equal(overFromBoxes(buy, sell, 75_000).edge, 100_000, '75K is nearer 100K than 50K by ratio');
  assert.equal(overFromBoxes(buy, sell, 70_000).edge, 50_000, '70K is nearer 50K');
  assert.equal(overFromBoxes(buy, sell, 2_000_000).edge, 1_000_000); assert.equal(overFromBoxes(buy, sell, 3_000_000).edge, 5_000_000);
  assert.equal(overFromBoxes(buy, sell, 75_000).exact, false); assert.equal(overFromBoxes(buy, sell, 50e6).edge, 5_000_000, 'past the last edge: the last');
  // a coin with sizes scaled down: its edges are BTC's times the scale
  const scaled = overFromBoxes(buy, sell, 10_000, 0.1);
  assert.deepEqual(scaled, { buy: from(3, buy), sell: from(3, sell), exact: true, edge: 10_000 });
});

test('only lines between box edges are asked for: at an edge the boxes are already exact', () => {
  assert.deepEqual(linesToAsk([100_000, 500_000], v => v), [], 'the defaults ask for nothing, as before the lines existed');
  assert.deepEqual(linesToAsk([2_000_000, 75_000, 75_000, 25_000, 10_000, 1_000_000], v => v), [75_000, 2_000_000], 'once each, in order, none at or under the floor');
  assert.deepEqual(linesToAsk([75_000], v => v * 0.1), [7_500], 'scaled for the coin on screen');
  assert.equal(atBoxEdge(10_000, 0.1), true); assert.equal(atBoxEdge(7_500, 0.1), false); assert.equal(atBoxEdge(0), false); assert.equal(atBoxEdge(25_000), true);
});
