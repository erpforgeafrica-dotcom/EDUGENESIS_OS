/**
 * Tests for project-root discovery and file collection.
 *
 * The case that matters here is a REGRESSION: the path-portability gate asked
 * `collectSourceFiles` to read named config files. That function walks
 * directories, so `readdirSync` threw `ENOTDIR`, `walk` swallowed it, and the
 * gate reported "0 config file(s)" and PASSED on every run since it was
 * written. The round-4 audit found it because the gate's own evidence line said
 * `0 config file(s)` while 17 config files sat in the tree.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { collectSourceFiles, listPublicPages, readSourceFiles } from './paths.js';

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'edugenesis-paths-'));
  mkdirSync(join(root, 'packages', 'alpha'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"name":"edugenesis-os"}\n', 'utf8');
  writeFileSync(
    join(root, 'packages', 'alpha', 'tsconfig.json'),
    '{"extends":"../../tsconfig.base.json"}\n',
    'utf8',
  );
  writeFileSync(join(root, 'packages', 'alpha', 'index.ts'), 'export const a = 1;\n', 'utf8');
  return root;
}

/**
 * A tree with the shipped browser pages.
 *
 * WHY TWO PAGES: a gate that names ONE page and claims to police "the shipped
 * UI" reports PASS when a second page ships and breaks every rule it enforces.
 */
function pagesFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'edugenesis-pages-'));
  const publicDir = join(root, 'apps', 'cli', 'public');
  mkdirSync(publicDir, { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"name":"edugenesis-os"}\n', 'utf8');
  writeFileSync(join(publicDir, 'index.html'), '<!doctype html><html lang="en"></html>\n', 'utf8');
  writeFileSync(join(publicDir, 'learn.html'), '<!doctype html><html lang="en"></html>\n', 'utf8');
  writeFileSync(join(publicDir, 'app.js'), 'console.log(1);\n', 'utf8');
  writeFileSync(join(publicDir, 'app.css'), ':root {}\n', 'utf8');
  return root;
}

test('the public page list holds EVERY html page under apps/*/public, and nothing else', () => {
  const root = pagesFixture();

  const pages = listPublicPages(root);

  assert.deepEqual(pages, ['apps/cli/public/index.html', 'apps/cli/public/learn.html']);
});

test('readSourceFiles reads a NAMED file, which a directory walker cannot', () => {
  const root = fixture();

  // The defect: a directory walker given a file path returns NOTHING.
  assert.deepEqual(collectSourceFiles(root, ['package.json']), []);

  // The fix: a named-file reader opens it.
  const files = readSourceFiles(root, ['package.json', 'packages/alpha/tsconfig.json']);
  assert.deepEqual(
    files.map((file) => file.relPath),
    ['package.json', 'packages/alpha/tsconfig.json'],
  );
  assert.match(files[1]?.content ?? '', /tsconfig\.base\.json/);
});

test('readSourceFiles reports a POSIX relative path and a readable absolute one', () => {
  const root = fixture();
  const [file] = readSourceFiles(root, ['packages/alpha/tsconfig.json']);
  assert.ok(file);
  assert.equal(file.relPath.includes('\\'), false);
  assert.match(file.absPath, /tsconfig\.json$/);
});

test('readSourceFiles skips a file that is absent instead of inventing an empty one', () => {
  const root = fixture();
  assert.deepEqual(readSourceFiles(root, ['nope.json']), []);
});

test('readSourceFiles does not descend a directory passed by name', () => {
  const root = fixture();
  // A directory is not a file: the reader must return nothing, not recurse.
  assert.deepEqual(readSourceFiles(root, ['packages']), []);
});
