/**
 * tools/sbom.mjs
 *
 * Generates a CycloneDX 1.5 Software Bill of Materials for the installed
 * dependency tree and writes it to `artifacts/sbom.cdx.json`.
 *
 * The SBOM is built by reading the manifest of every installed package under
 * `node_modules` directly. The `cyclonedx` npm package is NOT required — the
 * project has zero runtime dependencies and the SBOM must never introduce one.
 *
 * Every path is derived from this file's own location.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MODULES_DIR = join(ROOT, 'node_modules');
const ARTIFACTS_DIR = join(ROOT, 'artifacts');
const OUTPUT_PATH = join(ARTIFACTS_DIR, 'sbom.cdx.json');

/** Directories inside node_modules that are not packages. */
const IGNORED_ENTRIES = new Set(['.bin', '.package-lock.json', '.cache', '.modules.yaml']);

/** Read a package.json, returning undefined when it is unreadable or invalid. */
function readPackage(packageDir) {
  const manifestPath = join(packageDir, 'package.json');
  if (!existsSync(manifestPath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return undefined;
    if (typeof parsed.name !== 'string') return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/** Every installed package: `node_modules/<name>` and `node_modules/@scope/<name>`. */
function installedPackages() {
  const found = [];
  if (!existsSync(MODULES_DIR)) return found;

  let entries;
  try {
    entries = readdirSync(MODULES_DIR, { withFileTypes: true });
  } catch {
    return found;
  }

  for (const entry of entries) {
    if (IGNORED_ENTRIES.has(entry.name)) continue;
    const entryPath = join(MODULES_DIR, entry.name);

    if (entry.name.startsWith('@')) {
      let scoped;
      try {
        scoped = readdirSync(entryPath, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const scopedEntry of scoped) {
        const manifest = readPackage(join(entryPath, scopedEntry.name));
        if (manifest) found.push(manifest);
      }
      continue;
    }

    const manifest = readPackage(entryPath);
    if (manifest) found.push(manifest);
  }

  return found;
}

/** The project itself, described from its own manifest. */
function rootComponent() {
  const manifest = readPackage(ROOT);
  const name = manifest && typeof manifest.name === 'string' ? manifest.name : 'edugenesis-os';
  const version = manifest && typeof manifest.version === 'string' ? manifest.version : '0.0.0';
  return { type: 'application', name, version };
}

/** A CycloneDX component for one package. */
function toComponent(manifest) {
  const name = manifest.name;
  const version = typeof manifest.version === 'string' ? manifest.version : '0.0.0';
  const purl = `pkg:npm/${name}@${version}`;
  const component = {
    type: 'library',
    'bom-ref': purl,
    name,
    version,
    purl,
    scope: 'required',
  };

  if (typeof manifest.description === 'string' && manifest.description.length > 0) {
    component.description = manifest.description;
  }
  if (typeof manifest.license === 'string' && manifest.license.length > 0) {
    component.licenses = [{ license: { id: manifest.license } }];
  } else if (isRecord(manifest.license) && typeof manifest.license.type === 'string') {
    component.licenses = [{ license: { name: manifest.license.type } }];
  }

  const externalReferences = [];
  if (typeof manifest.homepage === 'string') {
    externalReferences.push({ type: 'website', url: manifest.homepage });
  }
  const repository = manifest.repository;
  const repositoryUrl =
    typeof repository === 'string'
      ? repository
      : isRecord(repository) && typeof repository.url === 'string'
        ? repository.url
        : undefined;
  if (repositoryUrl) {
    externalReferences.push({ type: 'vcs', url: repositoryUrl });
  }
  if (externalReferences.length > 0) component.externalReferences = externalReferences;

  const hash = createHash('sha256').update(`${name}@${version}`).digest('hex');
  component.hashes = [{ alg: 'SHA-256', content: hash }];

  return component;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The runtime dependency names declared by a manifest. */
function declaredDependencies(manifest) {
  const names = [];
  if (isRecord(manifest.dependencies)) {
    for (const name of Object.keys(manifest.dependencies)) names.push(name);
  }
  if (isRecord(manifest.optionalDependencies)) {
    for (const name of Object.keys(manifest.optionalDependencies)) names.push(name);
  }
  return names;
}

const root = rootComponent();
const manifests = installedPackages();
const components = manifests.map(toComponent).sort((a, b) => a.name.localeCompare(b.name));

const purlsByName = new Map(components.map((component) => [component.name, component.purl]));

// The dependency graph: root -> direct dependencies, package -> its dependencies.
const dependencies = [];
const rootDependsOn = [];
for (const name of declaredDependencies(root)) {
  const purl = purlsByName.get(name);
  if (purl) rootDependsOn.push(purl);
}
dependencies.push({ ref: root.name, dependsOn: rootDependsOn });

for (const manifest of manifests) {
  const purl = purlsByName.get(manifest.name);
  if (!purl) continue;
  const dependsOn = [];
  for (const name of declaredDependencies(manifest)) {
    const child = purlsByName.get(name);
    if (child && child !== purl) dependsOn.push(child);
  }
  dependencies.push({ ref: purl, dependsOn });
}

const sbom = {
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  serialNumber: `urn:uuid:${randomUUID()}`,
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    tools: [
      {
        vendor: 'EduGenesis OS',
        name: 'tools/sbom.mjs',
        version: root.version,
      },
    ],
    component: {
      type: 'application',
      'bom-ref': root.name,
      name: root.name,
      version: root.version,
    },
    properties: [
      { name: 'edugenesis:packageManager', value: 'npm' },
      { name: 'edugenesis:nodeVersion', value: process.version },
    ],
  },
  components,
  dependencies,
};

mkdirSync(ARTIFACTS_DIR, { recursive: true });
writeFileSync(OUTPUT_PATH, `${JSON.stringify(sbom, null, 2)}\n`, 'utf8');

const relativeOutput = relative(ROOT, OUTPUT_PATH).split(sep).join('/');
console.log(`CycloneDX 1.5 SBOM written to ${relativeOutput}`);
console.log(`components: ${components.length}`);
console.log(`root: ${root.name}@${root.version}`);
for (const component of components) {
  console.log(`  - ${component.name}@${component.version}`);
}
process.exit(0);
