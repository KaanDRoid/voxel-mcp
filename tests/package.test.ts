import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';

test('the distributable includes documentation referenced by the README', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { files: string[] };
  assert.ok(pkg.files.includes('docs'), 'documentation links must work after installing the package');
  assert.ok(pkg.files.includes('CHANGELOG.md'));
});
