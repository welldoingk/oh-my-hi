import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ── computeDateRange (inline — not exported, so logic is replicated here) ──
// Keep in sync with scripts/generate-dashboard.mjs:computeDateRange
function computeDateRange(scopeData) {
  let minTs = null, maxTs = null;
  for (const sdata of Object.values(scopeData)) {
    for (const entry of (sdata?.usage?.tokenEntries || [])) {
      const ts = entry.timestamp;
      if (!ts) continue;
      if (!minTs || ts < minTs) minTs = ts;
      if (!maxTs || ts > maxTs) maxTs = ts;
    }
  }
  return minTs && maxTs ? { from: minTs, to: maxTs } : null;
}

describe('computeDateRange', () => {
  it('returns null for empty scopeData', () => {
    assert.equal(computeDateRange({}), null);
  });

  it('returns null when no tokenEntries exist', () => {
    const scopeData = { global: { usage: { tokenEntries: [] } } };
    assert.equal(computeDateRange(scopeData), null);
  });

  it('returns null when tokenEntries have no timestamp', () => {
    const scopeData = { global: { usage: { tokenEntries: [{ model: 'haiku' }, { model: 'sonnet' }] } } };
    assert.equal(computeDateRange(scopeData), null);
  });

  it('returns from === to for a single entry', () => {
    const ts = '2025-06-15T10:00:00.000Z';
    const scopeData = { global: { usage: { tokenEntries: [{ timestamp: ts }] } } };
    const result = computeDateRange(scopeData);
    assert.deepEqual(result, { from: ts, to: ts });
  });

  it('returns correct min/max across multiple entries', () => {
    const scopeData = {
      global: {
        usage: {
          tokenEntries: [
            { timestamp: '2025-03-01T00:00:00.000Z' },
            { timestamp: '2025-01-15T00:00:00.000Z' },
            { timestamp: '2025-06-30T00:00:00.000Z' },
          ],
        },
      },
    };
    const result = computeDateRange(scopeData);
    assert.equal(result.from, '2025-01-15T00:00:00.000Z');
    assert.equal(result.to, '2025-06-30T00:00:00.000Z');
  });

  it('aggregates across multiple scopes', () => {
    const scopeData = {
      global: { usage: { tokenEntries: [{ timestamp: '2025-03-01T00:00:00.000Z' }] } },
      proj1:  { usage: { tokenEntries: [{ timestamp: '2024-11-01T00:00:00.000Z' }] } },
      proj2:  { usage: { tokenEntries: [{ timestamp: '2025-08-20T00:00:00.000Z' }] } },
    };
    const result = computeDateRange(scopeData);
    assert.equal(result.from, '2024-11-01T00:00:00.000Z');
    assert.equal(result.to, '2025-08-20T00:00:00.000Z');
  });

  it('skips scopes with missing usage', () => {
    const scopeData = {
      global: { usage: { tokenEntries: [{ timestamp: '2025-05-10T00:00:00.000Z' }] } },
      noUsage: {},
      nullUsage: { usage: null },
    };
    const result = computeDateRange(scopeData);
    assert.deepEqual(result, { from: '2025-05-10T00:00:00.000Z', to: '2025-05-10T00:00:00.000Z' });
  });

  it('skips entries with falsy timestamp', () => {
    const scopeData = {
      global: {
        usage: {
          tokenEntries: [
            { timestamp: null },
            { timestamp: '' },
            { timestamp: '2025-04-04T00:00:00.000Z' },
            { timestamp: undefined },
          ],
        },
      },
    };
    const result = computeDateRange(scopeData);
    assert.deepEqual(result, { from: '2025-04-04T00:00:00.000Z', to: '2025-04-04T00:00:00.000Z' });
  });
});

// ── SKILL.md bash command validation ──

describe('SKILL.md', () => {
  let skillContent;
  before(() => {
    skillContent = fs.readFileSync(path.join(ROOT, 'skills', 'omh', 'SKILL.md'), 'utf-8');
  });

  it('should search plugins directory broadly (not rely on CLAUDE_PLUGIN_ROOT)', () => {
    assert.ok(
      skillContent.includes('plugins') && skillContent.includes('generate-dashboard.mjs'),
      'bash command searches plugins directory for the script',
    );
    assert.ok(
      !skillContent.includes('CLAUDE_PLUGIN_ROOT'),
      'CLAUDE_PLUGIN_ROOT removed — it points to marketplace mirror, not install cache',
    );
  });

  it('should output an error message when script is not found', () => {
    assert.ok(skillContent.includes('ERROR'), 'error message present when script not found');
    assert.ok(skillContent.includes('exit 1'), 'exits with non-zero on failure');
  });

  it('should not use the old broken find pattern with extra wildcard level', () => {
    // old pattern: */oh-my-hi/*/scripts/ — extra * meant it never matched the actual install path
    assert.ok(!skillContent.includes('oh-my-hi/*/scripts'), 'old broken pattern removed');
  });
});
