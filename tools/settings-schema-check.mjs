/**
 * tools/settings-schema-check.mjs
 *
 * Validates `settings/settings.json` against `settings/settings.schema.json`
 * (JSON Schema draft 2020-12). Writes a small validator here on purpose: the
 * project has ZERO runtime dependencies, so this must not require `ajv` or any
 * other package.
 *
 * Exit code 0 = the committed default is valid and carries no secret.
 * Exit code 1 = at least one violation.
 *
 * Every path is derived from this file's own location. No absolute path, user
 * name or drive letter appears anywhere in this script.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA_PATH = join(ROOT, 'settings', 'settings.schema.json');
const DEFAULT_PATH = join(ROOT, 'settings', 'settings.json');
const LOCAL_PATH = join(ROOT, 'settings', 'settings.local.json');

// ---------------------------------------------------------------------------
// A small JSON Schema (draft 2020-12) validator
// ---------------------------------------------------------------------------

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function typeOfValue(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'object') return 'object';
  return 'unknown';
}

function matchesType(value, type) {
  const actual = typeOfValue(value);
  if (type === 'number') return actual === 'number' || actual === 'integer';
  if (type === 'object') return actual === 'object';
  return actual === type;
}

function joinPath(path, key) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]));
  }
  if (isRecord(a) && isRecord(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((key) => key in b && deepEqual(a[key], b[key]));
  }
  return false;
}

function resolvePointer(root, ref) {
  if (!ref.startsWith('#/')) return undefined;
  let current = root;
  for (const rawSegment of ref.slice(2).split('/')) {
    const segment = rawSegment.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!isRecord(current) && !Array.isArray(current)) return undefined;
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
    } else {
      current = current[segment];
    }
  }
  return isRecord(current) ? current : undefined;
}

function validateNode(value, schema, path, root, issues) {
  if (!isRecord(schema)) return;

  if (typeof schema.$ref === 'string') {
    const target = resolvePointer(root, schema.$ref);
    if (target) validateNode(value, target, path, root, issues);
    else issues.push({ path, message: `Unresolvable $ref "${schema.$ref}".` });
    return;
  }

  const declaredType = schema.type;
  if (typeof declaredType === 'string') {
    if (!matchesType(value, declaredType)) {
      issues.push({ path, message: `Expected type ${declaredType} but found ${typeOfValue(value)}.` });
      return;
    }
  } else if (Array.isArray(declaredType)) {
    const options = declaredType.filter((entry) => typeof entry === 'string');
    if (options.length > 0 && !options.some((option) => matchesType(value, option))) {
      issues.push({ path, message: `Expected one of [${options.join(', ')}] but found ${typeOfValue(value)}.` });
      return;
    }
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => deepEqual(candidate, value))) {
    issues.push({ path, message: 'Value is not one of the permitted values.' });
  }
  if ('const' in schema && !deepEqual(schema.const, value)) {
    issues.push({ path, message: 'Value must equal the declared constant.' });
  }

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      issues.push({ path, message: `String is shorter than ${schema.minLength} characters.` });
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      issues.push({ path, message: `String is longer than ${schema.maxLength} characters.` });
    }
    if (typeof schema.pattern === 'string') {
      let expression;
      try {
        expression = new RegExp(schema.pattern, 'u');
      } catch {
        expression = undefined;
      }
      if (expression && !expression.test(value)) {
        issues.push({ path, message: 'String does not match the required pattern.' });
      }
    }
  }

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      issues.push({ path, message: `Value must be >= ${schema.minimum}.` });
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      issues.push({ path, message: `Value must be <= ${schema.maximum}.` });
    }
    if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) {
      issues.push({ path, message: `Value must be > ${schema.exclusiveMinimum}.` });
    }
    if (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum) {
      issues.push({ path, message: `Value must be < ${schema.exclusiveMaximum}.` });
    }
    if (typeof schema.multipleOf === 'number' && schema.multipleOf > 0) {
      const quotient = value / schema.multipleOf;
      if (Math.abs(quotient - Math.round(quotient)) > 1e-9) {
        issues.push({ path, message: `Value must be a multiple of ${schema.multipleOf}.` });
      }
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      issues.push({ path, message: `Array must contain at least ${schema.minItems} items.` });
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      issues.push({ path, message: `Array must contain at most ${schema.maxItems} items.` });
    }
    if (schema.items !== undefined) {
      value.forEach((item, index) => validateNode(item, schema.items, `${path}[${index}]`, root, issues));
    }
  }

  if (isRecord(value)) {
    const properties = isRecord(schema.properties) ? schema.properties : undefined;
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (typeof key === 'string' && !(key in value)) {
          issues.push({ path: joinPath(path, key), message: 'Required property is missing.' });
        }
      }
    }
    if (schema.propertyNames !== undefined) {
      for (const key of Object.keys(value)) {
        validateNode(key, schema.propertyNames, joinPath(path, key), root, issues);
      }
    }
    const additional = schema.additionalProperties;
    for (const [key, child] of Object.entries(value)) {
      const childSchema = properties && isRecord(properties[key]) ? properties[key] : undefined;
      if (childSchema !== undefined) {
        validateNode(child, childSchema, joinPath(path, key), root, issues);
      } else if (additional === false) {
        issues.push({ path: joinPath(path, key), message: 'Unknown property is not permitted.' });
      } else if (additional !== undefined && additional !== true) {
        validateNode(child, additional, joinPath(path, key), root, issues);
      }
    }
  }

  if (Array.isArray(schema.allOf)) {
    for (const branch of schema.allOf) validateNode(value, branch, path, root, issues);
  }
  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    const matched = schema.anyOf.some((branch) => {
      const branchIssues = [];
      validateNode(value, branch, path, root, branchIssues);
      return branchIssues.length === 0;
    });
    if (!matched) issues.push({ path, message: 'Value does not satisfy any of the permitted schemas.' });
  }
  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    const matches = schema.oneOf.filter((branch) => {
      const branchIssues = [];
      validateNode(value, branch, path, root, branchIssues);
      return branchIssues.length === 0;
    }).length;
    if (matches !== 1) {
      issues.push({ path, message: `Value must satisfy exactly one permitted schema (matched ${matches}).` });
    }
  }
  if (schema.not !== undefined) {
    const negated = [];
    validateNode(value, schema.not, path, root, negated);
    if (negated.length === 0) issues.push({ path, message: 'Value matches a forbidden schema.' });
  }
}

export function validateAgainstSchema(value, schema) {
  const issues = [];
  if (!isRecord(schema)) {
    issues.push({ path: '$', message: 'Schema is not a JSON object.' });
    return issues;
  }
  validateNode(value, schema, '$', schema, issues);
  return issues;
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function collectApiKeyFindings(settings) {
  const findings = [];
  const providers = isRecord(settings) ? settings.providers : undefined;
  const apiKeys = isRecord(providers) ? providers.apiKeys : undefined;
  if (!isRecord(apiKeys)) return findings;
  for (const [name, value] of Object.entries(apiKeys)) {
    if (typeof value === 'string' && value.length > 0) {
      findings.push(`providers.apiKeys.${name} holds a non-empty value (${value.length} characters)`);
    }
  }
  return findings;
}

function report(label, issues, findings) {
  const problems = issues.map((issue) => `  ${issue.path}: ${issue.message}`);
  const secretProblems = findings.map((finding) => `  ${finding}`);
  if (problems.length === 0 && secretProblems.length === 0) {
    console.log(`PASS  ${label}`);
    return 0;
  }
  console.log(`FAIL  ${label}`);
  for (const line of [...problems, ...secretProblems]) console.log(line);
  return 1;
}

let failures = 0;

if (!existsSync(SCHEMA_PATH)) {
  console.error(`FAIL  schema file missing: settings/settings.schema.json`);
  process.exit(1);
}
if (!existsSync(DEFAULT_PATH)) {
  console.error(`FAIL  default settings file missing: settings/settings.json`);
  process.exit(1);
}

const schema = readJson(SCHEMA_PATH);
const settings = readJson(DEFAULT_PATH);

failures += report('settings/settings.json against settings/settings.schema.json', validateAgainstSchema(settings, schema), []);
failures += report('settings/settings.json carries no API key', [], collectApiKeyFindings(settings));

if (existsSync(LOCAL_PATH)) {
  const local = readJson(LOCAL_PATH);
  const localIssues = validateAgainstSchema(local, schema);
  if (localIssues.length === 0) {
    console.log('PASS  settings/settings.local.json against settings/settings.schema.json');
  } else {
    console.log('WARN  settings/settings.local.json does not validate against the schema:');
    for (const issue of localIssues) console.log(`  ${issue.path}: ${issue.message}`);
  }
}

if (failures === 0) {
  console.log('\nsettings schema check: OK');
  process.exit(0);
}
console.log(`\nsettings schema check: ${failures} failure(s)`);
process.exit(1);
