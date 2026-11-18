import { describe, expect, it } from 'vitest';
import { capabilityAllows } from '../../src/index.js';

describe('capabilityAllows', () => {
  it('matches an exact capability', () => {
    expect(capabilityAllows(['flags:ruleset:read'], 'flags:ruleset:read')).toBe(true);
    expect(capabilityAllows(['flags:ruleset:read'], 'flags:ruleset:write')).toBe(false);
  });

  it('lets `*` alone match everything', () => {
    expect(capabilityAllows(['*'], 'flags:ruleset:read')).toBe(true);
    expect(capabilityAllows(['*'], 'flags:ofrep:evaluate')).toBe(true);
    expect(capabilityAllows(['*'], 'config:read')).toBe(true);
  });

  it('lets `flags:*` match every flags capability, and nothing outside flags', () => {
    expect(capabilityAllows(['flags:*'], 'flags:ruleset:read')).toBe(true);
    expect(capabilityAllows(['flags:*'], 'flags:events:write')).toBe(true);
    expect(capabilityAllows(['flags:*'], 'flags:declarations:write')).toBe(true);
    expect(capabilityAllows(['flags:*'], 'flags:ofrep:evaluate')).toBe(true);
    expect(capabilityAllows(['flags:*'], 'config:read')).toBe(false);
  });

  it('lets a trailing `*` cover deeper paths', () => {
    expect(capabilityAllows(['flags:ruleset:*'], 'flags:ruleset:read')).toBe(true);
    expect(capabilityAllows(['flags:ruleset:*'], 'flags:ruleset:read:extra')).toBe(true);
    expect(capabilityAllows(['flags:ruleset:*'], 'flags:events:write')).toBe(false);
  });

  it('lets a trailing `*` match zero further segments', () => {
    expect(capabilityAllows(['flags:ruleset:*'], 'flags:ruleset')).toBe(true);
    expect(capabilityAllows(['flags:*'], 'flags')).toBe(true);
    expect(capabilityAllows(['flags:ruleset:*'], 'flags')).toBe(false);
    expect(capabilityAllows(['flags:*'], 'config')).toBe(false);
  });

  it('lets a middle `*` match exactly one segment', () => {
    expect(capabilityAllows(['flags:*:write'], 'flags:events:write')).toBe(true);
    expect(capabilityAllows(['flags:*:write'], 'flags:declarations:write')).toBe(true);
    expect(capabilityAllows(['flags:*:write'], 'flags:ruleset:read')).toBe(false);
    expect(capabilityAllows(['flags:*:write'], 'flags:a:b:write')).toBe(false);
  });

  it('implies nothing', () => {
    expect(capabilityAllows(['flags:events:write'], 'flags:ruleset:read')).toBe(false);
    expect(capabilityAllows(['flags:ruleset:read'], 'flags:ruleset:read:extra')).toBe(false);
    expect(capabilityAllows(['flags:ruleset:read:extra'], 'flags:ruleset:read')).toBe(false);
    expect(capabilityAllows(['flags'], 'flags:ruleset:read')).toBe(false);
  });

  it('ignores empty grants and non-string entries', () => {
    expect(capabilityAllows([], 'flags:ruleset:read')).toBe(false);
    expect(capabilityAllows([''], 'flags:ruleset:read')).toBe(false);
    expect(capabilityAllows([42, null] as unknown as string[], 'flags:ruleset:read')).toBe(false);
    expect(
      capabilityAllows(
        [undefined, 'flags:ruleset:read'] as unknown as string[],
        'flags:ruleset:read',
      ),
    ).toBe(true);
  });

  it('matches when any grant matches', () => {
    expect(capabilityAllows(['config:read', 'flags:*'], 'flags:events:write')).toBe(true);
  });
});
