import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { gunzipSync, gzipSync } from 'zlib';
import { parseUsage, loadTranscriptCache, loadMtimeIndex, saveMtimeIndex } from '../scripts/parsers/usage.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUTPUT = path.join(ROOT, 'output');
const CACHE_PATH = path.join(OUTPUT, 'transcript-cache.json');
const CACHE_DIR = path.join(OUTPUT, 'cache');
const PENDING_DIR = path.join(OUTPUT, 'pending');
const CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR
  || path.join(process.env.HOME, '.claude');

function cleanCache() {
  try { fs.unlinkSync(CACHE_PATH); } catch {}
  try { fs.rmSync(CACHE_DIR, { recursive: true }); } catch {}
  try { fs.rmSync(PENDING_DIR, { recursive: true }); } catch {}
}

function run(args = '') {
  return execSync(`node scripts/generate-dashboard.mjs ${args}`, {
    cwd: ROOT, encoding: 'utf-8', timeout: 30000,
  });
}

// ── Incremental Cache ──

describe('Incremental Cache', () => {
  describe('loadTranscriptCache', () => {
    it('should return empty object for null/undefined path', () => {
      assert.deepEqual(loadTranscriptCache(null), {});
      assert.deepEqual(loadTranscriptCache(undefined), {});
    });

    it('should return empty object for non-existent file', () => {
      assert.deepEqual(loadTranscriptCache('/tmp/oh-my-hi-nonexistent-cache.json'), {});
    });

    it('should migrate legacy uncompressed cache', () => {
      const tmpPath = path.join(OUTPUT, '_test_legacy.json');
      try {
        try { fs.rmSync(CACHE_DIR, { recursive: true }); } catch {}
        const data = { '/some/file.jsonl': { mtimeMs: 123, size: 456, result: { skills: [], agents: [], mcpCalls: [], tokenEntries: [], promptStats: [], latencyEntries: [] } } };
        fs.writeFileSync(tmpPath, JSON.stringify(data), 'utf8');
        const loaded = loadTranscriptCache(tmpPath);
        assert.equal(loaded['/some/file.jsonl'].mtimeMs, 123);
        assert.ok(!fs.existsSync(tmpPath), 'legacy file should be removed');
      } finally {
        try { fs.unlinkSync(tmpPath); } catch {}
      }
    });

    it('should load and merge multiple segment files', () => {
      cleanCache();
      // Create two segment files manually
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      const seg1 = { '/a.jsonl': { mtimeMs: 100, size: 10, result: { skills: [], agents: [], mcpCalls: [], tokenEntries: [], promptStats: [], latencyEntries: [] } } };
      const seg2 = { '/b.jsonl': { mtimeMs: 200, size: 20, result: { skills: [], agents: [], mcpCalls: [], tokenEntries: [], promptStats: [], latencyEntries: [] } } };
      fs.writeFileSync(path.join(CACHE_DIR, 'seg-001.json.gz'), gzipSync(JSON.stringify(seg1)));
      fs.writeFileSync(path.join(CACHE_DIR, 'seg-002.json.gz'), gzipSync(JSON.stringify(seg2)));
      const loaded = loadTranscriptCache(CACHE_PATH);
      assert.ok(loaded['/a.jsonl'], 'should have entry from seg1');
      assert.ok(loaded['/b.jsonl'], 'should have entry from seg2');
    });
  });

  describe('parseUsage with cache', () => {
    let sharedCache;
    let firstRunResult;

    before(async () => {
      sharedCache = {};
      firstRunResult = await parseUsage(CLAUDE_CONFIG_DIR, 0, null, { cache: sharedCache });
    });

    it('should return _cacheStats with parsed and total', () => {
      assert.ok(firstRunResult._cacheStats, '_cacheStats exists');
      assert.equal(typeof firstRunResult._cacheStats.parsed, 'number');
      assert.equal(typeof firstRunResult._cacheStats.total, 'number');
      assert.ok(firstRunResult._cacheStats.total >= 0, 'total >= 0');
    });

    it('should populate cache with _new flag on first parse', () => {
      const fileKeys = Object.keys(sharedCache).filter(k => !k.startsWith('_'));
      assert.ok(fileKeys.length > 0, 'cache should have file entries');
      const first = sharedCache[fileKeys[0]];
      assert.equal(typeof first.mtimeMs, 'number');
      assert.equal(typeof first.size, 'number');
      assert.ok(first.result, 'result exists');
      assert.equal(first._new, true, 'newly parsed entries should have _new flag');
    });

    it('should have zero parsed on second run with same cache', async () => {
      assert.ok(firstRunResult._cacheStats.parsed > 0, 'first run should parse files');
      sharedCache._parsed = 0;
      const r2 = await parseUsage(CLAUDE_CONFIG_DIR, 0, null, { cache: sharedCache });
      assert.equal(r2._cacheStats.parsed, 0, 'second run should parse 0 files');
    });

    it('should apply cutoff filtering with days parameter', async () => {
      sharedCache._parsed = 0;
      const recentResult = await parseUsage(CLAUDE_CONFIG_DIR, 7, null, { cache: sharedCache });
      assert.ok(
        recentResult.tokenEntries.length <= firstRunResult.tokenEntries.length,
        '7-day tokens <= all-time tokens'
      );
    });
  });
});

// ── Mtime Index ──

describe('Mtime Index', () => {
  it('should use relative paths with _base prefix', () => {
    cleanCache();
    run('--data-only');
    const indexPath = path.join(CACHE_DIR, 'mtime-index.json');
    assert.ok(fs.existsSync(indexPath), 'mtime-index.json should exist');
    const raw = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    assert.ok(raw._base, '_base field should exist');
    assert.ok(typeof raw._base === 'string', '_base should be a string path');
    // No key should contain the _base prefix (all relative)
    const keys = Object.keys(raw).filter(k => k !== '_base');
    assert.ok(keys.length > 0, 'should have file entries');
    for (const k of keys) {
      assert.ok(!k.startsWith('/'), `key "${k.slice(0, 30)}..." should be relative`);
    }
  });

  it('should restore absolute paths on load', () => {
    const loaded = loadMtimeIndex(CACHE_PATH);
    const keys = Object.keys(loaded);
    assert.ok(keys.length > 0, 'should have entries');
    for (const k of keys) {
      assert.ok(k.startsWith('/'), `loaded key should be absolute: ${k.slice(0, 40)}...`);
      assert.equal(typeof loaded[k], 'number', 'value should be mtime number');
    }
  });

  it('should be smaller than full-path version', () => {
    const indexPath = path.join(CACHE_DIR, 'mtime-index.json');
    const raw = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    const loaded = loadMtimeIndex(CACHE_PATH);
    const fullSize = JSON.stringify(loaded).length;
    const relSize = JSON.stringify(raw).length;
    assert.ok(relSize < fullSize, `relative (${relSize}) should be smaller than full (${fullSize})`);
  });
});

// ── Data.js Separation ──

describe('Data.js Separation', () => {
  before(() => {
    cleanCache();
    run('--data-only');
  });

  it('should generate separate data.js file', () => {
    const dataJsPath = path.join(OUTPUT, 'data.js');
    assert.ok(fs.existsSync(dataJsPath), 'data.js should exist');
  });

  it('data.js should define DATA variable', () => {
    const content = fs.readFileSync(path.join(OUTPUT, 'data.js'), 'utf-8');
    assert.ok(content.startsWith('let DATA ='), 'should start with let DATA =');
    assert.ok(content.endsWith(';'), 'should end with semicolon');
  });

  it('data.js should contain minified usage data', () => {
    const content = fs.readFileSync(path.join(OUTPUT, 'data.js'), 'utf-8');
    // Extract JSON from "let DATA = {...};"
    const json = content.slice('let DATA = '.length, -1);
    const data = JSON.parse(json);
    assert.equal(data._minified, true, 'should have _minified flag');
  });

  it('data.json should contain full (non-minified) data', () => {
    const data = JSON.parse(fs.readFileSync(path.join(OUTPUT, 'data.json'), 'utf-8'));
    assert.equal(data._minified, undefined, 'data.json should not be minified');
    assert.ok(data.scopeData, 'should have scopeData');
  });

  it('index.html should load data via script src', () => {
    const html = fs.readFileSync(path.join(OUTPUT, 'index.html'), 'utf-8');
    assert.ok(html.includes('src="data.js"'), 'should have <script src="data.js">');
    assert.ok(!html.includes('let DATA ='), 'should NOT have inline DATA');
  });

  it('index.html should not contain __DATA__ placeholder', () => {
    const template = fs.readFileSync(path.join(ROOT, 'templates', 'dashboard.html'), 'utf-8');
    assert.ok(!template.includes('__DATA__'), 'template should not have __DATA__ placeholder');
    assert.ok(template.includes('src="data.js"'), 'template should reference data.js');
  });
});

// ── Conditional HTML Rebuild ──

describe('Conditional HTML Rebuild', () => {
  it('should rebuild index.html when missing', () => {
    try { fs.unlinkSync(path.join(OUTPUT, 'index.html')); } catch {}
    run('--data-only');
    assert.ok(fs.existsSync(path.join(OUTPUT, 'index.html')), 'should recreate index.html');
  });

  it('should not rebuild index.html when version matches', () => {
    // Get current mtime
    const statBefore = fs.statSync(path.join(OUTPUT, 'index.html'));
    // Wait 1s to ensure mtime would differ
    execSync('sleep 1');
    run('--data-only');
    const statAfter = fs.statSync(path.join(OUTPUT, 'index.html'));
    assert.equal(statBefore.mtimeMs, statAfter.mtimeMs, 'index.html should not be rewritten');
  });
});

// ── Upgrade Compatibility ──

describe('Upgrade Compatibility', () => {
  it('should create data.js on --data-only when data.js is missing but data.json exists', () => {
    // Simulate upgrade: data.json exists (old version), data.js missing (new feature)
    const dataJsPath = path.join(OUTPUT, 'data.js');
    try { fs.unlinkSync(dataJsPath); } catch {}
    assert.ok(fs.existsSync(path.join(OUTPUT, 'data.json')), 'data.json should pre-exist');
    assert.ok(!fs.existsSync(dataJsPath), 'data.js should be missing');

    run('--data-only');
    assert.ok(fs.existsSync(dataJsPath), 'data.js should be created from existing data.json');
    const content = fs.readFileSync(dataJsPath, 'utf-8');
    assert.ok(content.startsWith('let DATA ='), 'data.js should define DATA');
  });

  it('should rebuild index.html on version mismatch (upgrade)', () => {
    // Tamper version in index.html to simulate old version
    const indexPath = path.join(OUTPUT, 'index.html');
    const html = fs.readFileSync(indexPath, 'utf-8');
    fs.writeFileSync(indexPath, html.replace(/v\d+\.\d+\.\d+/, 'v0.0.0'), 'utf-8');

    run('--data-only');
    const newHtml = fs.readFileSync(indexPath, 'utf-8');
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
    assert.ok(newHtml.includes(pkg.version), 'index.html should have current version after rebuild');
  });

  it('should handle missing cache dir gracefully on --data-only', () => {
    cleanCache();
    // No cache, no pending, no mtime-index — cold lightweight run
    const output = run('--data-only');
    assert.ok(output.includes('lightweight'), 'should run in lightweight mode');
    assert.ok(output.includes('done'), 'should complete without error');
  });
});

// ── Pending Files (Lightweight Mode) ──

describe('Pending Files', () => {
  before(() => {
    cleanCache();
  });

  it('--data-only should create pending file (not gz segment)', () => {
    run('--data-only');
    assert.ok(fs.existsSync(PENDING_DIR), 'pending directory should exist');
    const files = fs.readdirSync(PENDING_DIR).filter(f => f.endsWith('.json'));
    assert.ok(files.length > 0, 'should have pending files');
    // Verify it's plain JSON
    const content = fs.readFileSync(path.join(PENDING_DIR, files[0]), 'utf8');
    assert.doesNotThrow(() => JSON.parse(content), 'should be valid JSON');
    // Should NOT have gz segments (only mtime-index)
    const cacheFiles = fs.existsSync(CACHE_DIR) ? fs.readdirSync(CACHE_DIR) : [];
    const gzFiles = cacheFiles.filter(f => f.endsWith('.json.gz'));
    assert.equal(gzFiles.length, 0, 'lightweight mode should not create gz segments');
  });

  it('--data-only should update data.js when files changed', () => {
    const dataJsBefore = fs.readFileSync(path.join(OUTPUT, 'data.js'), 'utf-8');
    // Run again — active session transcript changes, so data.js should update
    run('--data-only');
    const output = run('--data-only');
    // If files were parsed, data.js should be updated
    if (output.includes('parsed, ')) {
      // data.js was potentially updated
      assert.ok(fs.existsSync(path.join(OUTPUT, 'data.js')), 'data.js should exist');
    }
  });

  it('should not include _cacheStats in data.json', () => {
    const data = JSON.parse(fs.readFileSync(path.join(OUTPUT, 'data.json'), 'utf-8'));
    for (const [scope, sdata] of Object.entries(data.scopeData)) {
      if (sdata.usage) {
        assert.equal(sdata.usage._cacheStats, undefined, `${scope} should not have _cacheStats`);
      }
    }
  });
});

// ── Progressive Loading ──

describe('Progressive Loading', () => {
  it('should use lightweight mode with --data-only', () => {
    cleanCache();
    const output = run('--data-only');
    assert.ok(output.includes('lightweight'), 'should use lightweight mode');
    assert.ok(!output.includes('progressive mode'), 'should not trigger progressive');
  });

  it('should create mtime-index on --data-only', () => {
    assert.ok(fs.existsSync(path.join(CACHE_DIR, 'mtime-index.json')), 'mtime-index should exist');
  });

  it('should show skipped stats on second lightweight run', () => {
    const output = run('--data-only');
    assert.ok(output.includes('skipped'), 'should show skipped count');
  });

  it('should not include _partial flag in data.json', () => {
    const data = JSON.parse(fs.readFileSync(path.join(OUTPUT, 'data.json'), 'utf-8'));
    assert.equal(data._partial, undefined, '_partial should not exist');
  });
});

// ── findSkillFiles Exclusions ──

describe('findSkillFiles exclusions', () => {
  let skillsSource;
  before(() => {
    skillsSource = fs.readFileSync(path.join(ROOT, 'scripts', 'parsers', 'skills.mjs'), 'utf-8');
  });

  it('should exclude node_modules from recursive scan', () => {
    assert.ok(skillsSource.includes('node_modules'), 'SKIP_DIRS should include node_modules');
  });

  it('should exclude .git from recursive scan', () => {
    assert.ok(skillsSource.includes("'.git'"), 'SKIP_DIRS should include .git');
  });

  it('should exclude temp_git_ prefixed directories', () => {
    assert.ok(skillsSource.includes("'temp_git_'"), 'SKIP_DIR_PREFIXES should include temp_git_');
  });

  it('should exclude temp_local_ prefixed directories', () => {
    assert.ok(skillsSource.includes("'temp_local_'"), 'SKIP_DIR_PREFIXES should include temp_local_');
  });
});

// ── Web UI — Partial Banner ──

describe('Web UI — Partial Banner', () => {
  let appJs, css, enLocale, koLocale;

  before(() => {
    appJs = fs.readFileSync(path.join(ROOT, 'templates', 'app.js'), 'utf-8');
    css = fs.readFileSync(path.join(ROOT, 'templates', 'styles.css'), 'utf-8');
    enLocale = JSON.parse(fs.readFileSync(path.join(ROOT, 'templates', 'locales', 'en.json'), 'utf-8'));
    koLocale = JSON.parse(fs.readFileSync(path.join(ROOT, 'templates', 'locales', 'ko.json'), 'utf-8'));
  });

  it('should have showPartialBanner function in app.js', () => {
    assert.ok(appJs.includes('showPartialBanner'), 'showPartialBanner function');
    assert.ok(appJs.includes('DATA._partial'), 'checks DATA._partial');
    assert.ok(appJs.includes('partial-banner'), 'creates partial-banner element');
    assert.ok(appJs.includes('partial-spinner'), 'creates partial-spinner element');
    assert.ok(appJs.includes("t('partialBannerMsg')"), 'uses i18n key');
  });

  it('should call showPartialBanner at boot', () => {
    const bootSection = appJs.slice(appJs.indexOf('// ── Boot'));
    assert.ok(bootSection.includes('showPartialBanner()'), 'called during boot');
  });

  it('should have partial-banner CSS styles', () => {
    assert.ok(css.includes('.partial-banner'), 'partial-banner class');
    assert.ok(css.includes('.partial-spinner'), 'partial-spinner class');
    assert.ok(css.includes('partial-spin'), 'partial-spin animation');
  });

  it('should share base styles between update-banner and partial-banner', () => {
    assert.ok(
      css.includes('.update-banner,\n.partial-banner') ||
      css.includes('.update-banner, .partial-banner'),
      'banners should share base styles via grouped selector'
    );
  });

  it('should have partialBannerMsg in all locales', () => {
    assert.ok(enLocale.partialBannerMsg, 'en locale has partialBannerMsg');
    assert.ok(koLocale.partialBannerMsg, 'ko locale has partialBannerMsg');
    assert.ok(enLocale.partialBannerMsg.includes('7 days'), 'en mentions 7 days');
    assert.ok(koLocale.partialBannerMsg.includes('7일'), 'ko mentions 7일');
  });
});
