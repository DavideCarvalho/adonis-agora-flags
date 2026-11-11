import { parseSync } from '@swc/core';
import { describe, expect, it } from 'vitest';
import { renderFlagTypes } from '../../commands/flags_types.js';

describe('flags:types', () => {
  it('renders valid declarations for console flags', () => {
    const out = renderFlagTypes(
      {
        promo_banner: {
          type: 'string',
          default: 'off',
          variants: ['off', 'blue'],
          description: 'Home */ promo',
        },
        limit: { type: 'number', default: 3 },
        dark_mode: { type: 'boolean', default: false },
        config: { type: 'json', default: {} },
      },
      { strict: true },
    );
    expect(out).toContain('"promo_banner": "off" | "blue";');
    expect(out).toContain('"limit": number;');
    expect(out).toContain('"dark_mode": boolean;');
    expect(out).toContain('"config": JsonValue;');
    expect(out).toContain('strictKeys: true');
    expect(() => parseSync(out, { syntax: 'typescript' })).not.toThrow();
    expect(renderFlagTypes({}, { strict: false })).not.toContain('strictKeys');
  });
});
