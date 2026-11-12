/**
 * Repair: replace hardcoded absolute paths in tsconfig files with relative ones.
 *
 * The portability law (GLOBAL.md §9) forbids hardcoded absolute paths, drive letters
 * and user names in anything that ships with the project. TypeScript project
 * references and `extends` are resolved relative to the tsconfig file itself, so
 * a relative path is both correct and portable.
 *
 *   node tools/fix-tsconfig-paths.mjs
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function tsconfigsIn(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...tsconfigsIn(full));
    else if (entry === 'tsconfig.json') out.push(full);
  }
  return out;
}

const targets = [
  ...tsconfigsIn(join(ROOT, 'packages')),
  ...tsconfigsIn(join(ROOT, 'apps')),
  join(ROOT, 'tsconfig.json'),
].filter((p) => {
  try { statSync(p); return true; } catch { return false; }
});

let changed = 0;
for (const file of targets) {
  const original = readFileSync(file, 'utf8');
  const dir = dirname(file);
  const toRelative = (target) => {
    const abs = target.replace(/\\/g, '/');
    const rel = relative(dir, abs).replace(/\\/g, '/');
    return rel.startsWith('.') ? rel : `./${rel}`;
  };

  let updated = original;
  // "extends": "<abs>"
  updated = updated.replace(/("extends"\s*:\s*")([^"]+)(")/g, (m, a, p, c) => {
    if (!/[A-Za-z]:[\\/]/.test(p) && !p.startsWith('/')) return m;
    return a + toRelative(p) + c;
  });
  // "path": "<abs>"  (project references)
  updated = updated.replace(/("path"\s*:\s*")([^"]+)(")/g, (m, a, p, c) => {
    if (!/[A-Za-z]:[\\/]/.test(p) && !p.startsWith('/')) return m;
    return a + toRelative(p) + c;
  });

  if (updated !== original) {
    writeFileSync(file, updated, 'utf8');
    changed++;
    console.log('fixed ->', file.replace(ROOT + sep, ''));
  }
}
console.log(`tsconfig paths repaired: ${changed} file(s) changed of ${targets.length} inspected`);

// Fail loudly if anything still holds an absolute path.
const offenders = [];
for (const file of targets) {
  const text = readFileSync(file, 'utf8');
  if (/[A-Za-z]:[\\/]/.test(text)) offenders.push(file.replace(ROOT + sep, ''));
}
if (offenders.length) {
  console.error('STILL ABSOLUTE:', offenders.join(', '));
  process.exit(1);
}
console.log('verification: no absolute paths remain in any tsconfig');
