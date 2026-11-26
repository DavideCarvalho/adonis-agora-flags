import { describe, it } from 'vitest';
import { cryptoKitCases } from '../../src/crypto-kit/crypto-kit.cases.js';

// The canonical kit's tests, copied with the kit. Do not edit the cases in one lib: fix the
// canonical copy in _1x/shared/crypto-kit and re-sync every lib.
describe('crypto-kit', () => {
  for (const [name, run] of Object.entries(cryptoKitCases)) it(name, run);
});
