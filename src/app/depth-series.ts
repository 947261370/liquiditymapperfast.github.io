/** One instrument's recorded columns, flat as the worker holds them: `counts[c]` bins of column `c` (ascending), starting at `times[c]`. */
export interface DepthStore { step: number; times: ArrayLike<number>; counts: ArrayLike<number>; bins: ArrayLike<number>; bid: ArrayLike<number>; ask: ArrayLike<number> }
export interface DepthSeries { bid: Float32Array; ask: Float32Array; /** The price each pixel column's band is centred on (NaN where no book gave one). */ mid: Float64Array }

/**
 * The middle of one column's book: halfway between its highest bin with bids and its lowest bin with asks (`count` bins from `at`), or NaN
 * when a side is missing. A column is a minute's mean, so in a minute the price moved through, the two cross and the middle is the middle of
 * where it went: still a price of that minute, never a later one.
 */
export function touchOf(store: DepthStore, at: number, count: number): number {
  let lowAsk = NaN, highBid = NaN;
  for (let e = at; e < at + count; e++) if (store.ask[e]! > 0) { lowAsk = store.bins[e]! * store.step; break; }
  for (let e = at + count - 1; e >= at; e--) if (store.bid[e]! > 0) { highBid = store.bins[e]! * store.step; break; }
  return (lowAsk + highBid) / 2;
}

/**
 * Bid and ask USD within `range` (a fraction) either side of the price in each of `w` pixel columns over [t0, t1], summed over the
 * instruments; an instrument's columns that fall in one pixel are averaged.
 *
 * The price is the books' own: each instrument's `touchOf`, averaged over its columns in the pixel, and the median of those across the
 * instruments, so one venue with a stale or crossed book does not move it. Each side counts its own volume anywhere inside the band; the
 * band is not split at the price. The pane used to centre the band on the close of the chart candle holding the column, a price from later
 * in that candle, and to count bids only below it and asks only above it, which moved the dense liquidity at the touch from one side to the
 * other whenever the two prices differed. Over 48 hours of the BTC recording (2026-10-10, 15-minute candles, ±20 %), 64 of the 72 minutes
 * in which one side fell by 12 % or more began on a candle boundary, and 43 of the 44 ask drops were followed by a higher price, because the
 * centre already was that price. Counted this way there were none.
 */
export function depthSeries(stores: readonly DepthStore[], stepMs: number, t0: number, t1: number, w: number, range: number): DepthSeries {
  const by = depthByStore(stores, stepMs, t0, t1, w, range), bid = new Float32Array(w), ask = new Float32Array(w);
  for (let i = 0; i < stores.length; i++) for (let x = 0; x < w; x++) { bid[x]! += by.bid[i]![x]!; ask[x]! += by.ask[i]![x]!; }
  return { bid, ask, mid: by.mid };
}

/** `depthSeries` before the instruments are added together: each store's bid and ask per pixel, and whether it had a column there. */
export interface DepthByStore { mid: Float64Array; bid: Float32Array[]; ask: Float32Array[]; present: Uint8Array[] }
export function depthByStore(stores: readonly DepthStore[], stepMs: number, t0: number, t1: number, w: number, range: number): DepthByStore {
  const mid = new Float64Array(w).fill(NaN), out: DepthByStore = { mid, bid: stores.map(() => new Float32Array(w)), ask: stores.map(() => new Float32Array(w)), present: stores.map(() => new Uint8Array(w)) };
  if (!(w > 0) || !(t1 > t0)) return out;
  const pxMs = (t1 - t0) / w, m = stores.length;
  const first = (t: number): number => Math.max(0, Math.floor((t - t0) / pxMs)), last = (t: number): number => Math.min(w - 1, Math.floor((t + stepMs - 1 - t0) / pxMs));
  const touch = new Float64Array(w * m), seen = new Uint32Array(w * m);
  stores.forEach((store, i) => {
    for (let c = 0, at = 0; c < store.times.length; at += store.counts[c]!, c++) {
      const count = store.counts[c]!, x0 = first(store.times[c]!), x1 = last(store.times[c]!);
      if (x1 < 0 || x0 >= w || count <= 0) continue;
      const p = touchOf(store, at, count);
      if (p > 0) for (let x = x0; x <= x1; x++) { touch[x * m + i]! += p; seen[x * m + i]!++; }
    }
  });
  const row: number[] = [];
  for (let x = 0; x < w; x++) {
    row.length = 0;
    for (let i = 0; i < m; i++) if (seen[x * m + i]) row.push(touch[x * m + i]! / seen[x * m + i]!);
    if (row.length) { row.sort((a, b) => a - b); mid[x] = row[row.length >> 1]!; }
  }
  const sumB = new Float64Array(w), sumA = new Float64Array(w), n = new Float64Array(w);
  stores.forEach((store, i) => {
    sumB.fill(0); sumA.fill(0); n.fill(0);
    for (let c = 0, at = 0; c < store.times.length; at += store.counts[c]!, c++) {
      const count = store.counts[c]!, x0 = first(store.times[c]!), x1 = last(store.times[c]!);
      if (x1 < 0 || x0 >= w || count <= 0) continue;
      for (let x = x0; x <= x1; x++) {
        const p = mid[x]!; if (!(p > 0)) continue;
        const lo = p * (1 - range), hi = p * (1 + range);
        let b = 0, a = 0;
        for (let e = at; e < at + count; e++) { const price = store.bins[e]! * store.step; if (price >= lo && price <= hi) { b += store.bid[e]!; a += store.ask[e]!; } }
        sumB[x]! += b; sumA[x]! += a; n[x]! += 1;
      }
    }
    const bid = out.bid[i]!, ask = out.ask[i]!, present = out.present[i]!;
    for (let x = 0; x < w; x++) if (n[x]! > 0) { bid[x] = sumB[x]! / n[x]!; ask[x] = sumA[x]! / n[x]!; present[x] = 1; }
  });
  return out;
}
