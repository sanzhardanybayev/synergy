import { describe, expect, it } from 'vitest';
import { setMarketplaceVersion, setSkillStamp } from '../src/stamp.js';

describe('setMarketplaceVersion', () => {
  it('rewrites the version field, preserving formatting', () => {
    const input = '{\n  "plugins": [\n    { "name": "synergy", "version": "0.6.0" }\n  ]\n}\n';
    expect(setMarketplaceVersion(input, '0.7.0')).toContain('"version": "0.7.0"');
  });
});

describe('setSkillStamp', () => {
  it('updates an existing stamp', () => {
    const md = '---\nname: x\n---\n<!-- synergy-version: 0.6.0 -->\n\nbody\n';
    expect(setSkillStamp(md, '0.7.0')).toContain('<!-- synergy-version: 0.7.0 -->');
  });
  it('inserts a stamp after frontmatter when missing', () => {
    const md = '---\nname: x\n---\n\nbody\n';
    const out = setSkillStamp(md, '0.7.0');
    expect(out).toMatch(/---\n<!-- synergy-version: 0.7.0 -->/);
  });
  it('keeps the Step-0 MINE literal in lockstep with the stamp', () => {
    const md = '---\nx\n---\n<!-- synergy-version: 0.6.0 -->\n\nMINE="0.6.0"\n';
    const out = setSkillStamp(md, '0.7.0');
    expect(out).toContain('MINE="0.7.0"');
    expect(out).toContain('synergy-version: 0.7.0');
  });
});
