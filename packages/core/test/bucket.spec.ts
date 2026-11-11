import { describe, expect, it } from 'vitest';
import { BUCKET_COUNT, bucketOf, murmur3, pickVariant } from '../src/bucket.js';

describe('murmur3', () => {
  it('matches the reference x86_32 vectors', () => {
    expect(murmur3('')).toBe(0);
    expect(murmur3('', 1)).toBe(0x514e28b7);
    expect(murmur3('hello')).toBe(0x248bfa47);
    expect(murmur3('The quick brown fox jumps over the lazy dog')).toBe(0x2e4ff723);
  });

  it('hashes the UTF-8 bytes, not UTF-16 code units', () => {
    expect(murmur3('ação')).not.toBe(murmur3('acao'));
    expect(murmur3('ação')).toBe(murmur3('ação'));
  });
});

describe('bucketOf', () => {
  it('is deterministic and in range', () => {
    const b = bucketOf('checkout', 'user-1');
    expect(b).toBe(bucketOf('checkout', 'user-1'));
    expect(b).toBeGreaterThanOrEqual(0);
    expect(b).toBeLessThan(BUCKET_COUNT);
  });

  it('spreads keys roughly uniformly', () => {
    const counts = [0, 0, 0, 0];
    for (let i = 0; i < 40_000; i++) counts[Math.floor(bucketOf('f', `u${i}`) / 2500)]!++;
    for (const c of counts) expect(Math.abs(c - 10_000)).toBeLessThan(400);
  });
});

describe('pickVariant', () => {
  const split = [
    { variant: 'a', weight: 1 },
    { variant: 'b', weight: 3 },
  ];

  it('assigns consecutive ranges proportional to weight', () => {
    expect(pickVariant(split, 0)).toBe('a');
    expect(pickVariant(split, 2499)).toBe('a');
    expect(pickVariant(split, 2500)).toBe('b');
    expect(pickVariant(split, BUCKET_COUNT - 1)).toBe('b');
  });

  it('skips zero weights and returns undefined when nothing is positive', () => {
    expect(
      pickVariant(
        [
          { variant: 'a', weight: 0 },
          { variant: 'b', weight: 5 },
        ],
        0,
      ),
    ).toBe('b');
    expect(pickVariant([{ variant: 'a', weight: 0 }], 0)).toBeUndefined();
  });

  it('only moves boundary keys when a weight grows', () => {
    const before = [
      { variant: 'on', weight: 10 },
      { variant: 'off', weight: 90 },
    ];
    const after = [
      { variant: 'on', weight: 25 },
      { variant: 'off', weight: 75 },
    ];
    for (let b = 0; b < BUCKET_COUNT; b += 7) {
      if (pickVariant(before, b) === 'on') expect(pickVariant(after, b)).toBe('on');
    }
  });
});
