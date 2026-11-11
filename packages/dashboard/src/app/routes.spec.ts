import { describe, expect, it } from 'vitest';
import { formatRoute, parseRoute } from './routes';

describe('hash routes', () => {
  it('lands on the flag list for an empty or unknown hash', () => {
    expect(parseRoute('')).toEqual({ screen: 'flags' });
    expect(parseRoute('#/nope')).toEqual({ screen: 'flags' });
  });

  it('round-trips a flag in another environment', () => {
    const route = { screen: 'flags' as const, id: 'checkout v2', env: 'staging' };
    const hash = formatRoute(route);
    expect(hash).toBe('#/flags/checkout%20v2?env=staging');
    expect(parseRoute(hash)).toEqual(route);
  });

  it('keeps the environment on screens without an id', () => {
    expect(parseRoute('#/approvals?env=qa')).toEqual({ screen: 'approvals', env: 'qa' });
    expect(parseRoute('#/ops/whatever')).toEqual({ screen: 'ops' });
  });

  it('survives a hand-typed bad escape', () => {
    expect(parseRoute('#/flags/100%')).toEqual({ screen: 'flags', id: '100%' });
  });
});
