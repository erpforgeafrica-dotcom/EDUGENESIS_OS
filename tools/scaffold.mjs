/**
 * Deterministic workspace scaffolder.
 *
 * Generates package.json + tsconfig.json for every package directory so that the
 * implementation agents have an identical, predictable layout and never have to
 * guess. Idempotent: refuses to overwrite an existing package.json.
 *
 *   node tools/scaffold.mjs
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** @type {{name:string,dir:string,deps?:string[]}[]} */
const PACKAGES = [
  { name: '@edugenesis/contracts', dir: 'packages/contracts' },
  { name: '@edugenesis/accessibility', dir: 'packages/accessibility', deps: ['@edugenesis/contracts'] },
  { name: '@edugenesis/onekey', dir: 'packages/onekey', deps: ['@edugenesis/contracts'] },
  { name: '@edugenesis/ledger', dir: 'packages/ledger', deps: ['@edugenesis/contracts'] },
  { name: '@edugenesis/identity', dir: 'packages/identity', deps: ['@edugenesis/contracts'] },
  { name: '@edugenesis/verification', dir: 'packages/verification', deps: ['@edugenesis/contracts'] },
  { name: '@edugenesis/cli', dir: 'apps/cli', deps: ['@edugenesis/contracts'] },
];

for (const pkg of PACKAGES) {
  const dir = join(ROOT, pkg.dir);
  mkdirSync(join(dir, 'src'), { recursive: true });

  const pkgJsonPath = join(dir, 'package.json');
  if (!existsSync(pkgJsonPath)) {
    const pkgJson = {
      name: pkg.name,
      version: '0.1.0',
      private: true,
      type: 'module',
      main: './dist/index.js',
      types: './dist/index.d.ts',
      exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
      scripts: { build: 'tsc -b', clean: 'tsc -b --clean' },
      dependencies: Object.fromEntries((pkg.deps ?? []).map((d) => [d, '0.1.0'])),
    };
    writeFileSync(pkgJsonPath, JSON.stringify(pkgJson, null, 2) + '\n', 'utf8');
    console.log('package.json ->', pkg.dir);
  } else {
    console.log('package.json exists, left alone ->', pkg.dir);
  }

  const tsPath = join(dir, 'tsconfig.json');
  if (!existsSync(tsPath)) {
    // RELATIVE paths only. An absolute path here bakes a drive letter and a user
    // name into the project, which the portability law forbids and which
    // tools/verify-portability.mjs fails the build on.
    const relToRoot = (target) => {
      const rel = relative(dir, target).split(/[\\/]/).join('/');
      return rel.startsWith('.') ? rel : `./${rel}`;
    };
    const ts = {
      extends: relToRoot(join(ROOT, 'tsconfig.base.json')),
      compilerOptions: { rootDir: './src', outDir: './dist' },
      include: ['src/**/*.ts'],
      exclude: ['dist', 'node_modules'],
    };
    if ((pkg.deps ?? []).length > 0) {
      ts.references = pkg.deps.map((d) => {
        const target = PACKAGES.find((p) => p.name === d);
        return { path: relToRoot(join(ROOT, target.dir, 'tsconfig.json')) };
      });
    }
    writeFileSync(tsPath, JSON.stringify(ts, null, 2) + '\n', 'utf8');
    console.log('tsconfig.json ->', pkg.dir);
  } else {
    console.log('tsconfig.json exists, left alone ->', pkg.dir);
  }

  const readme = join(dir, 'README.md');
  if (!existsSync(readme)) {
    writeFileSync(
      readme,
      `# ${pkg.name}\n\nOwned by swarm unit **${pkg.dir}**. Implements the interfaces declared in \`packages/contracts\`.\n\n` +
        `- Source: \`src/\`\n- Tests: \`src/**/*.test.ts\` (compiled to \`dist/**/*.test.js\`)\n` +
        `- Run them with a GLOB: \`node --test "packages/${pkg.dir.split('/').pop()}/dist/**/*.test.js"\`.\n` +
        `- NEVER use a bare directory path with \`node --test\` on Node 24 — it resolves as one module and reports a FALSE GREEN ("tests 1, pass 1") while running nothing. \`npm run test:only\` wraps the command in a meta-gate that fails on a zero-test run.\n` +
        `- This package MUST NOT import a provider SDK. Provider access lives behind \`packages/onekey\`.\n` +
        `- This package MUST NOT contain a raw hex colour or a hardcoded absolute path.\n`,
      'utf8'
    );
  }
}

console.log('scaffold complete');
