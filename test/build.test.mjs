import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUTPUT = path.join(ROOT, 'output');

describe('Build', () => {
  before(() => {
    // Run full build
    execSync('node scripts/generate-dashboard.mjs --data-only', {
      cwd: ROOT,
      encoding: 'utf-8',
      timeout: 30000,
    });
  });

  it('should generate output/index.html', () => {
    assert.ok(fs.existsSync(path.join(OUTPUT, 'index.html')));
  });

  it('should generate output/data.json', () => {
    assert.ok(fs.existsSync(path.join(OUTPUT, 'data.json')));
  });

  it('should generate output/task-categories.json', () => {
    assert.ok(fs.existsSync(path.join(OUTPUT, 'task-categories.json')));
  });

  describe('data.json', () => {
    let data;

    before(() => {
      data = JSON.parse(fs.readFileSync(path.join(OUTPUT, 'data.json'), 'utf-8'));
    });

    it('should have scopes array', () => {
      assert.ok(Array.isArray(data.scopes));
      assert.ok(data.scopes.length > 0, 'at least 1 scope');
    });

    it('should have global scope with required fields', () => {
      const global = data.scopeData?.global;
      assert.ok(global, 'global scope exists');
      for (const key of ['skills', 'agents', 'plugins', 'hooks', 'memory', 'mcpServers', 'rules', 'principles', 'commands', 'teams', 'plans', 'todos']) {
        assert.ok(Array.isArray(global[key]), `global.${key} is array`);
      }
    });

    it('should have usage data in global scope', () => {
      const usage = data.scopeData?.global?.usage;
      assert.ok(usage, 'usage exists');
      for (const key of ['tokenEntries', 'promptStats', 'latencyEntries', 'skills', 'agents', 'commands', 'mcpCalls']) {
        assert.ok(Array.isArray(usage[key]), `usage.${key} is array`);
      }
    });

    it('should have taskCategories with mapping and meta', () => {
      assert.ok(data.taskCategories, 'taskCategories exists');
      assert.ok(data.taskCategories.mapping, 'mapping exists');
      assert.ok(data.taskCategories.meta, 'meta exists');
    });

    it('should have generatedAt timestamp', () => {
      assert.ok(data.generatedAt);
      assert.ok(!isNaN(new Date(data.generatedAt).getTime()), 'valid ISO date');
    });

    it('should have configDir', () => {
      assert.ok(typeof data.configDir === 'string');
    });

    it('should have _devBuild flag when built from git repo', () => {
      // Test runs from the git repo, so _devBuild should be true
      assert.equal(data._devBuild, true);
    });
  });

  describe('index.html', () => {
    let html;

    before(() => {
      html = fs.readFileSync(path.join(OUTPUT, 'index.html'), 'utf-8');
    });

    it('should be a valid HTML document', () => {
      assert.ok(html.startsWith('<!DOCTYPE html>'));
      assert.ok(html.includes('</html>'));
    });

    it('should have all placeholders replaced', () => {
      // __BB_JS__ and __BB_DARK_CSS__ may appear as minified variable names in inlined JS,
      // so we check for the template pattern with surrounding delimiters instead
      assert.ok(!html.includes('>__BB_CSS__<'), 'BB_CSS placeholder');
      assert.ok(!html.includes('>__STYLES__<'), 'STYLES placeholder');
      assert.ok(!html.includes('>__APP_JS__<'), 'APP_JS placeholder');
      assert.ok(html.includes('let DATA ='), 'DATA should be inlined');
      assert.ok(!html.includes('__VERSION__'), 'VERSION placeholder');
    });

    it('should contain inlined DATA variable', () => {
      assert.ok(html.includes('let DATA ='));
    });

    it('should contain inlined billboard.js', () => {
      assert.ok(html.includes('bb.generate') || html.includes('billboard'));
    });

    it('should contain app.js code', () => {
      assert.ok(html.includes('renderContent'));
      assert.ok(html.includes('renderOverview'));
    });

    it('should contain CSS styles', () => {
      assert.ok(html.includes('--accent'));
      assert.ok(html.includes('.sidebar'));
    });

    it('should contain version from package.json', () => {
      const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
      assert.ok(html.includes(pkg.version));
    });
  });
});
