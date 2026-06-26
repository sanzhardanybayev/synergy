import { describe, expect, it } from 'vitest';
import { compareVersions, isStale, newest } from '../src/versions.js';

describe('compareVersions', () => {
  it('orders by semver, not lexically', () => {
    expect(compareVersions('0.9.0', '0.10.0')).toBe(-1);
    expect(compareVersions('0.10.0', '0.9.0')).toBe(1);
    expect(compareVersions('0.6.0', '0.6.0')).toBe(0);
  });
});

describe('newest', () => {
  it('returns the highest semver or null on empty', () => {
    expect(newest(['0.3.0', '0.10.0', '0.6.0'])).toBe('0.10.0');
    expect(newest([])).toBeNull();
  });
});

describe('isStale', () => {
  it('is true only when a strictly newer version is installed', () => {
    expect(isStale('0.5.0', ['0.3.0', '0.5.0', '0.6.0'])).toBe(true);
    expect(isStale('0.6.0', ['0.3.0', '0.6.0'])).toBe(false); // newest
    expect(isStale('0.7.0', ['0.6.0'])).toBe(false); // downgrade case
    expect(isStale('0.6.0', [])).toBe(false); // nothing installed
  });
});
