// number-format.test.mjs — behavior contract for fmtCompact, the canonical
// number formatter documented in CLAUDE.md → Code Conventions → Number
// Formatting. The function lives inside templates/app.js (browser bundle)
// and isn't exported, so these tests verify the source-level behavior by
// extracting and evaluating the function in isolation.
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// Pull fmtNum + fmtCompact source out of app.js and evaluate them inside a
// plain JS function scope. This keeps the tests literal: any edit to those
// functions in app.js flows straight through to the assertions.
let fmtCompact;
let fmtNum;
before(() => {
  const src = fs.readFileSync(path.join(ROOT, 'templates', 'app.js'), 'utf-8');
  const fmtNumMatch = src.match(/function fmtNum[\s\S]*?\n  }/);
  const fmtCompactMatch = src.match(/function fmtCompact[\s\S]*?\n  }/);
  if (!fmtNumMatch || !fmtCompactMatch) {
    throw new Error('Could not locate fmtNum / fmtCompact in templates/app.js');
  }
  // Minimal shim: t() provides the numLocale used by fmtNum's Intl formatter.
  // We hardcode 'en-US' for deterministic assertions.
  // eslint-disable-next-line no-new-func
  const make = new Function(`
    const t = (k) => k === 'numLocale' ? 'en-US' : '';
    let _numFmt = new Intl.NumberFormat('en-US');
    ${fmtNumMatch[0]}
    ${fmtCompactMatch[0]}
    return { fmtNum, fmtCompact };
  `);
  const fns = make();
  fmtNum = fns.fmtNum;
  fmtCompact = fns.fmtCompact;
});

describe('fmtCompact — canonical number formatter', () => {
  it('uses Intl.NumberFormat (locale separator) for values under 10,000', () => {
    assert.equal(fmtCompact(0), '0');
    assert.equal(fmtCompact(1), '1');
    assert.equal(fmtCompact(42), '42');
    assert.equal(fmtCompact(999), '999');
    assert.equal(fmtCompact(1000), '1,000');
    assert.equal(fmtCompact(9999), '9,999');
  });

  it('switches to SI prefix at 10,000', () => {
    assert.equal(fmtCompact(10000), '10K');
    assert.equal(fmtCompact(12300), '12.3K');
    assert.equal(fmtCompact(999999), '1000K');
  });

  it('uses M prefix for millions', () => {
    assert.equal(fmtCompact(1e6), '1M');
    assert.equal(fmtCompact(1.2e6), '1.2M');
    assert.equal(fmtCompact(12_345_000), '12.3M');
  });

  it('uses B prefix for billions', () => {
    assert.equal(fmtCompact(1e9), '1B');
    assert.equal(fmtCompact(2.5e9), '2.5B');
  });

  it('strips trailing .0 for clean display', () => {
    assert.equal(fmtCompact(12000), '12K'); // not "12.0K"
    assert.equal(fmtCompact(1_000_000), '1M'); // not "1.0M"
    assert.equal(fmtCompact(20_000), '20K');
  });

  it('preserves sign for negative numbers', () => {
    assert.equal(fmtCompact(-50), '-50');
    assert.equal(fmtCompact(-12_300), '-12.3K');
    assert.equal(fmtCompact(-1e6), '-1M');
  });

  it('handles non-numeric input gracefully', () => {
    assert.equal(fmtCompact(NaN), 'NaN');
    assert.equal(fmtCompact(Infinity), 'Infinity');
    assert.equal(fmtCompact('foo'), 'foo');
    assert.equal(fmtCompact(null), 'null');
  });
});

describe('fmtNum — raw Intl.NumberFormat path', () => {
  it('returns locale-formatted number for any size', () => {
    assert.equal(fmtNum(1000), '1,000');
    assert.equal(fmtNum(1_234_567), '1,234,567');
  });

  it('returns string input unchanged', () => {
    assert.equal(fmtNum('abc'), 'abc');
  });
});
