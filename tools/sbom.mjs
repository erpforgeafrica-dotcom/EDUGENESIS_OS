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
import { createHash } from 'node:crypto';
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

/**
 * The SBOM timestamp: `SOURCE_DATE_EPOCH` if the build system declares one,
 * otherwise `null` and the field is omitted.
 *
 * WHY THE COMMIT DATE IS NOT A FALLBACK
 *   `metadata.timestamp` is optional in CycloneDX 1.5. Deriving it from the
 *   HEAD commit date makes the document a function of the commit that carries
 *   it: committing `sbom.cdx.json` moves HEAD, so the next generation produces
 *   a different timestamp, the working tree is dirty again, and no checkout can
 *   ever reproduce its own committed SBOM. That is the same self-reference that
 *   `tools/attest.mjs` had. Deriving it from "now" is worse: two runs over an
 *   unchanged tree disagree and the checksum binds nothing.
 *
 *   The document therefore identifies the dependency graph and nothing else.
 *   When a build system wants the timestamp it sets `SOURCE_DATE_EPOCH`, the
 *   reproducible-builds convention, and the value is recorded verbatim.
 */
function sbomTimestamp() {
  const epoch = process.env['SOURCE_DATE_EPOCH'];
  if (typeof epoch !== 'string' || !/^\d+$/.test(epoch.trim())) return null;
  const declared = new Date(Number(epoch.trim()) * 1000);
  return Number.isNaN(declared.getTime()) ? null : declared.toISOString();
}

/**
 * A content-derived UUID for the BOM serial.
 *
 * WHY NOT `randomUUID()`: the serial is the identity of the document. If it is
 * random, two runs over an unchanged tree disagree, and nothing downstream can
 * tell "the SBOM changed" from "the SBOM was generated again". This derives the
 * serial from the dependency graph itself and shapes it as a version-5 UUID so
 * CycloneDX consumers still receive a well-formed `urn:uuid:`.
 *
 * The toolchain (Node version) is deliberately NOT part of the identity: the
 * serial names the dependency graph, not the machine that serialised it.
 */
function contentUuid(content) {
  const digest = createHash('sha256').update(content).digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
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

// The identity of the document is its dependency graph — nothing else.
const serialNumber = `urn:uuid:${contentUuid(JSON.stringify({ root, components, dependencies }))}`;

const sbom = {
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  serialNumber,
  version: 1,
  metadata: {
    timestamp: sbomTimestamp(),
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
