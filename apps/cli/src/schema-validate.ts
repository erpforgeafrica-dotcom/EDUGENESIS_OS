/**
 * A small, dependency-free JSON Schema validator.
 *
 * It implements the subset of draft 2020-12 that `settings/settings.schema.json`
 * actually uses:
 *
 *   type, enum, const, properties, required, additionalProperties,
 *   propertyNames, items, minItems, maxItems, minimum, maximum,
 *   exclusiveMinimum, exclusiveMaximum, multipleOf, minLength, maxLength,
 *   pattern, allOf, anyOf, oneOf, not, $ref (local JSON pointer only)
 *
 * No `any`, no `@ts-ignore`. Every unknown node is handled defensively.
 */

export interface SchemaIssue {
  /** JSONPath-like location, e.g. `$.server.port`. */
  readonly path: string;
  /** Human-readable description of the violation. */
  readonly message: string;
}

export type SchemaObject = Record<string, unknown>;

function isRecord(value: unknown): value is SchemaObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function typeOfValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'object') return 'object';
  return 'unknown';
}

function matchesType(value: unknown, type: string): boolean {
  const actual = typeOfValue(value);
  if (type === 'number') return actual === 'number' || actual === 'integer';
  if (type === 'object') return actual === 'object';
  return actual === type;
}

function joinPath(path: string, key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  if (isRecord(a) && isRecord(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((key) => key in b && deepEqual(a[key], b[key]));
  }
  return false;
}

/** Resolve a local JSON pointer such as `#/$defs/thing`. */
function resolvePointer(root: SchemaObject, ref: string): SchemaObject | undefined {
  if (!ref.startsWith('#/')) return undefined;
  let current: unknown = root;
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

function validateNode(
  value: unknown,
  schema: unknown,
  path: string,
  root: SchemaObject,
  issues: SchemaIssue[],
): void {
  if (!isRecord(schema)) return;

  if (typeof schema['$ref'] === 'string') {
    const target = resolvePointer(root, schema['$ref']);
    if (target) validateNode(value, target, path, root, issues);
    else issues.push({ path, message: `Unresolvable $ref "${schema['$ref']}".` });
    return;
  }

  // ---- type -------------------------------------------------------------
  const declaredType = schema['type'];
  if (typeof declaredType === 'string') {
    if (!matchesType(value, declaredType)) {
      issues.push({ path, message: `Expected type ${declaredType} but found ${typeOfValue(value)}.` });
      return;
    }
  } else if (Array.isArray(declaredType)) {
    const options = declaredType.filter((entry): entry is string => typeof entry === 'string');
    if (options.length > 0 && !options.some((option) => matchesType(value, option))) {
      issues.push({ path, message: `Expected one of [${options.join(', ')}] but found ${typeOfValue(value)}.` });
      return;
    }
  }

  // ---- enum / const -----------------------------------------------------
  if (Array.isArray(schema['enum'])) {
    const allowed = schema['enum'];
    if (!allowed.some((candidate) => deepEqual(candidate, value))) {
      issues.push({ path, message: `Value is not one of the permitted values.` });
    }
  }
  if ('const' in schema && !deepEqual(schema['const'], value)) {
    issues.push({ path, message: `Value must equal the declared constant.` });
  }

  // ---- string -----------------------------------------------------------
  if (typeof value === 'string') {
    const minLength = schema['minLength'];
    if (typeof minLength === 'number' && value.length < minLength) {
      issues.push({ path, message: `String is shorter than ${minLength} characters.` });
    }
    const maxLength = schema['maxLength'];
    if (typeof maxLength === 'number' && value.length > maxLength) {
      issues.push({ path, message: `String is longer than ${maxLength} characters.` });
    }
    const pattern = schema['pattern'];
    if (typeof pattern === 'string') {
      let expression: RegExp | undefined;
      try {
        expression = new RegExp(pattern, 'u');
      } catch {
        expression = undefined;
      }
      if (expression && !expression.test(value)) {
        issues.push({ path, message: `String does not match the required pattern.` });
      }
    }
  }

  // ---- number -----------------------------------------------------------
  if (typeof value === 'number') {
    const minimum = schema['minimum'];
    if (typeof minimum === 'number' && value < minimum) {
      issues.push({ path, message: `Value must be >= ${minimum}.` });
    }
    const maximum = schema['maximum'];
    if (typeof maximum === 'number' && value > maximum) {
      issues.push({ path, message: `Value must be <= ${maximum}.` });
    }
    const exclusiveMinimum = schema['exclusiveMinimum'];
    if (typeof exclusiveMinimum === 'number' && value <= exclusiveMinimum) {
      issues.push({ path, message: `Value must be > ${exclusiveMinimum}.` });
    }
    const exclusiveMaximum = schema['exclusiveMaximum'];
    if (typeof exclusiveMaximum === 'number' && value >= exclusiveMaximum) {
      issues.push({ path, message: `Value must be < ${exclusiveMaximum}.` });
    }
    const multipleOf = schema['multipleOf'];
    if (typeof multipleOf === 'number' && multipleOf > 0) {
      const quotient = value / multipleOf;
      if (Math.abs(quotient - Math.round(quotient)) > 1e-9) {
        issues.push({ path, message: `Value must be a multiple of ${multipleOf}.` });
      }
    }
  }

  // ---- array ------------------------------------------------------------
  if (Array.isArray(value)) {
    const minItems = schema['minItems'];
    if (typeof minItems === 'number' && value.length < minItems) {
      issues.push({ path, message: `Array must contain at least ${minItems} items.` });
    }
    const maxItems = schema['maxItems'];
    if (typeof maxItems === 'number' && value.length > maxItems) {
      issues.push({ path, message: `Array must contain at most ${maxItems} items.` });
    }
    const items = schema['items'];
    if (items !== undefined) {
      value.forEach((item, index) => {
        validateNode(item, items, `${path}[${index}]`, root, issues);
      });
    }
  }

  // ---- object -----------------------------------------------------------
  if (isRecord(value)) {
    const properties = isRecord(schema['properties']) ? schema['properties'] : undefined;
    const required = schema['required'];
    if (Array.isArray(required)) {
      for (const key of required) {
        if (typeof key === 'string' && !(key in value)) {
          issues.push({ path: joinPath(path, key), message: `Required property is missing.` });
        }
      }
    }
    const propertyNames = schema['propertyNames'];
    if (propertyNames !== undefined) {
      for (const key of Object.keys(value)) {
        validateNode(key, propertyNames, joinPath(path, key), root, issues);
      }
    }
    const additional = schema['additionalProperties'];
    for (const [key, child] of Object.entries(value)) {
      const childSchema = properties && isRecord(properties[key]) ? properties[key] : undefined;
      if (childSchema !== undefined) {
        validateNode(child, childSchema, joinPath(path, key), root, issues);
      } else if (additional === false) {
        issues.push({ path: joinPath(path, key), message: `Unknown property is not permitted.` });
      } else if (additional !== undefined && additional !== true) {
        validateNode(child, additional, joinPath(path, key), root, issues);
      }
    }
  }

  // ---- combinators ------------------------------------------------------
  if (Array.isArray(schema['allOf'])) {
    for (const branch of schema['allOf']) {
      validateNode(value, branch, path, root, issues);
    }
  }
  if (Array.isArray(schema['anyOf']) && schema['anyOf'].length > 0) {
    const matched = schema['anyOf'].some((branch) => {
      const branchIssues: SchemaIssue[] = [];
      validateNode(value, branch, path, root, branchIssues);
      return branchIssues.length === 0;
    });
    if (!matched) issues.push({ path, message: `Value does not satisfy any of the permitted schemas.` });
  }
  if (Array.isArray(schema['oneOf']) && schema['oneOf'].length > 0) {
    const matches = schema['oneOf'].filter((branch) => {
      const branchIssues: SchemaIssue[] = [];
      validateNode(value, branch, path, root, branchIssues);
      return branchIssues.length === 0;
    }).length;
    if (matches !== 1) {
      issues.push({ path, message: `Value must satisfy exactly one of the permitted schemas (matched ${matches}).` });
    }
  }
  if (schema['not'] !== undefined) {
    const negated: SchemaIssue[] = [];
    validateNode(value, schema['not'], path, root, negated);
    if (negated.length === 0) issues.push({ path, message: `Value matches a forbidden schema.` });
  }
}

/**
 * Validate `value` against `schema`.
 * Returns an empty array when the value is valid.
 */
export function validateAgainstSchema(value: unknown, schema: unknown): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  if (!isRecord(schema)) {
    issues.push({ path: '$', message: `Schema is not a JSON object.` });
    return issues;
  }
  validateNode(value, schema, '$', schema, issues);
  return issues;
}

/** Format issues as one line each. */
export function formatIssues(issues: readonly SchemaIssue[]): string[] {
  return issues.map((issue) => `${issue.path}: ${issue.message}`);
}
