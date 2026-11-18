/**
 * tools/sign-tier-zero.mjs
 *
 * Owner-only offline signer for a Tier 0 bundle:
 *
 *   node tools/sign-tier-zero.mjs <bundle.json> <output.sig>
 *
 * The private key path comes ONLY from EDUGENESIS_BUNDLE_SIGNING_KEY. The env
 * var must point OUTSIDE the repository root — a key inside the tree is
 * refused. No key material is ever printed. Uses only node built-ins
 * (ADR-0014): node:crypto, node:fs, node:path, node:url.
 *
 * The canonicalBytes() below MUST stay byte-identical to canonicalBundleBytes()
 * in ed25519-signature.ts; both sign and verify depend on the same bytes.
 */
import { createPrivateKey, sign as cryptoSign } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function fail(message) {
  console.error(`sign-tier-zero: ${message}`);
  process.exit(1);
}

function canonicalBytes(bundle) {
  const lessons = Array.isArray(bundle?.lessons) ? bundle.lessons : [];
  const canonical = {
    version: bundle.version,
    watermark: bundle.watermark,
    lessons: lessons.map((lesson) => ({ id: lesson.id, body: lesson.body })),
  };
  return Buffer.from(JSON.stringify(canonical), 'utf8');
}

const [bundleArg, outputArg] = process.argv.slice(2);
if (!bundleArg || !outputArg) {
  fail('usage: node tools/sign-tier-zero.mjs <bundle.json> <output.sig>');
}

const keyEnv = process.env.EDUGENESIS_BUNDLE_SIGNING_KEY;
if (typeof keyEnv !== 'string' || keyEnv.trim() === '') {
  fail('EDUGENESIS_BUNDLE_SIGNING_KEY is not set; point it at the offline private key path.');
}

const keyPath = resolve(keyEnv);
const rel = relative(ROOT, keyPath);
const insideRepo =
  rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
if (insideRepo) {
  fail('the signing key resolves inside the repository root; keep the private key OUTSIDE the repo.');
}

let bundle;
try {
  bundle = JSON.parse(readFileSync(resolve(bundleArg), 'utf8'));
} catch (error) {
  fail(`could not read/parse the bundle file: ${error.message}`);
}
if (bundle === null || typeof bundle !== 'object' || Array.isArray(bundle)) {
  fail('the bundle file must contain a JSON object.');
}

let privateKey;
try {
  privateKey = createPrivateKey(readFileSync(keyPath));
} catch (error) {
  fail(`could not load the private key: ${error.message}`);
}

let signature;
try {
  signature = cryptoSign(null, canonicalBytes(bundle), privateKey).toString('base64');
} catch (error) {
  fail(`signing failed: ${error.message}`);
}

try {
  writeFileSync(resolve(outputArg), `${signature}\n`, 'utf8');
} catch (error) {
  fail(`could not write the signature file: ${error.message}`);
}

console.log('Tier 0 bundle signed. Owner custody checklist:');
console.log('  [ ] Private key stayed on an offline machine; it never entered the repo or a network log.');
console.log('  [ ] The key path came only from EDUGENESIS_BUNDLE_SIGNING_KEY and was outside the repo.');
console.log('  [ ] Signature file is stored beside the bundle; neither contains key material.');
console.log('  [ ] Public key is embedded in verifier config; private key remains in KMS/HSM or offline vault.');
console.log('  [ ] Verify the signed bundle with the owner ceremony before promoting it to Tier 0.');
