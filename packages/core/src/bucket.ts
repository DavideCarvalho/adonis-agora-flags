import type { WeightedVariant } from './ruleset.js';

/** Number of buckets a key is hashed into. 10000 gives 0.01% rollout granularity. */
export const BUCKET_COUNT = 10_000;

const encoder = new TextEncoder();

/**
 * MurmurHash3 (x86, 32-bit) over the UTF-8 bytes of `input`. Chosen because it is fast,
 * well distributed, dependency-free and identical in every runtime, so a tenant, the
 * control-plane and a browser preview all put the same key in the same bucket.
 */
export function murmur3(input: string, seed = 0): number {
  const bytes = encoder.encode(input);
  const length = bytes.length;
  const blocks = length >>> 2;
  const c1 = 0xcc9e2d51;
  const c2 = 0x1b873593;
  let h = seed >>> 0;

  for (let i = 0; i < blocks; i++) {
    const o = i << 2;
    let k =
      (bytes[o]! | (bytes[o + 1]! << 8) | (bytes[o + 2]! << 16) | (bytes[o + 3]! << 24)) >>> 0;
    k = Math.imul(k, c1);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, c2);
    h ^= k;
    h = (h << 13) | (h >>> 19);
    h = (Math.imul(h, 5) + 0xe6546b64) >>> 0;
  }

  const tail = blocks << 2;
  let k = 0;
  switch (length & 3) {
    // biome-ignore lint/suspicious/noFallthroughSwitchClause: murmur3 tail falls through by design
    case 3:
      k ^= bytes[tail + 2]! << 16;
    // biome-ignore lint/suspicious/noFallthroughSwitchClause: murmur3 tail falls through by design
    case 2:
      k ^= bytes[tail + 1]! << 8;
    case 1:
      k ^= bytes[tail]!;
      k = Math.imul(k, c1);
      k = (k << 15) | (k >>> 17);
      k = Math.imul(k, c2);
      h ^= k;
  }

  h ^= length;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** The bucket (0 … BUCKET_COUNT-1) a key lands in for a flag. */
export function bucketOf(salt: string, bucketKey: string): number {
  return murmur3(`${salt}:${bucketKey}`) % BUCKET_COUNT;
}

/**
 * Picks the arm of a split for a bucket. Arms own consecutive ranges proportional to their
 * weight, in declaration order. In a two-arm rollout (`on` first), growing `on`'s share only
 * moves keys from `off` into `on`, never the other way. With three or more arms, changing a
 * weight can reassign keys between later arms — that is what sticky assignment is for.
 * Returns `undefined` when no arm has a positive weight.
 */
export function pickVariant(split: WeightedVariant[], bucket: number): string | undefined {
  const total = split.reduce((sum, arm) => sum + Math.max(arm.weight, 0), 0);
  if (total <= 0) return undefined;
  const point = (bucket / BUCKET_COUNT) * total;
  let upper = 0;
  for (const arm of split) {
    if (arm.weight <= 0) continue;
    upper += arm.weight;
    if (point < upper) return arm.variant;
  }
  // Floating point can leave `point` a hair above the last bound; it belongs to the last arm.
  for (let i = split.length - 1; i >= 0; i--) if (split[i]!.weight > 0) return split[i]!.variant;
  return undefined;
}
