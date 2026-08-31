import YAML from 'yaml';
import { ConfigError, type ConfigIssue, issue } from './errors.js';

/**
 * Hardened YAML loading.
 *
 * Config files are an input surface, so the parser is configured for the
 * smallest useful language rather than the full spec:
 *
 *   - `schema: 'core'` and `customTags: []` — no type extensions.
 *   - Warnings are treated as errors. The parser reports an unresolved tag as a
 *     *warning* and silently falls back to a string, so `!!js/function "..."`
 *     would otherwise pass through as harmless-looking data.
 *   - `maxAliasCount: 0` — anchors and aliases are refused outright, which
 *     removes the billion-laughs class instead of bounding it.
 *   - `merge: false` plus an explicit `<<` check — merge keys hide the real
 *     shape of a document from review.
 *   - Byte and depth limits before and after parsing.
 */
export interface SafeYamlLimits {
  readonly maxBytes: number;
  readonly maxDepth: number;
  readonly maxNodes: number;
}

export const DEFAULT_YAML_LIMITS: SafeYamlLimits = {
  maxBytes: 256 * 1024,
  maxDepth: 24,
  maxNodes: 20_000,
};

const measure = (
  value: unknown,
  limits: SafeYamlLimits,
  depth: number,
  state: { nodes: number },
  path: string,
  issues: ConfigIssue[],
): void => {
  if (depth > limits.maxDepth) {
    issues.push(
      issue(
        'YAML_TOO_DEEP',
        path,
        `nesting exceeds the maximum depth of ${String(limits.maxDepth)}`,
      ),
    );
    return;
  }
  state.nodes += 1;
  if (state.nodes > limits.maxNodes) {
    issues.push(
      issue(
        'YAML_TOO_DEEP',
        path,
        `document exceeds the maximum of ${String(limits.maxNodes)} nodes`,
      ),
    );
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => {
      measure(v, limits, depth + 1, state, `${path}[${String(i)}]`, issues);
    });
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [k, v] of Object.entries(value)) {
      if (k === '<<') {
        issues.push(
          issue(
            'YAML_MERGE_KEY_FORBIDDEN',
            path,
            'merge keys (`<<`) are not allowed in configuration',
          ),
        );
      }
      measure(v, limits, depth + 1, state, path === '' ? k : `${path}.${k}`, issues);
    }
  }
};

/**
 * Parse YAML into a plain JSON-compatible value, or throw ConfigError.
 * The result contains only objects, arrays, strings, numbers, booleans and null.
 */
export const parseSafeYaml = (
  source: string,
  limits: SafeYamlLimits = DEFAULT_YAML_LIMITS,
): unknown => {
  const issues: ConfigIssue[] = [];

  const bytes = Buffer.byteLength(source, 'utf8');
  if (bytes > limits.maxBytes) {
    throw new ConfigError([
      issue(
        'YAML_TOO_LARGE',
        '',
        `document is ${String(bytes)} bytes, which exceeds the maximum of ${String(limits.maxBytes)}`,
      ),
    ]);
  }

  let doc: YAML.Document.Parsed;
  try {
    doc = YAML.parseDocument(source, {
      version: '1.2',
      schema: 'core',
      customTags: [],
      merge: false,
      keepSourceTokens: false,
      uniqueKeys: true,
    });
  } catch {
    throw new ConfigError([issue('YAML_SYNTAX', '', 'invalid YAML')]);
  }

  for (const e of doc.errors) {
    issues.push(issue('YAML_SYNTAX', '', `invalid YAML (${e.code})`));
  }
  for (const w of doc.warnings) {
    // An unresolved tag is not benign: the parser degrades it to a string, so a
    // document carrying an unexpected type would otherwise validate.
    issues.push(
      issue(
        w.code === 'TAG_RESOLVE_FAILED' ? 'YAML_UNRESOLVED_TAG' : 'YAML_SYNTAX',
        '',
        `unsupported YAML construct (${w.code}); only the core schema is accepted`,
      ),
    );
  }
  if (issues.length > 0) throw new ConfigError(issues);

  // Alias resolution is disabled here rather than bounded. Refusing anchors
  // outright removes the billion-laughs class instead of picking a limit, and
  // an anchor in a reviewed config file hides the real shape from the reviewer.
  // The library signals this by throwing, so it is caught rather than collected.
  let value: unknown;
  try {
    value = doc.toJS({ maxAliasCount: 0 });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : '';
    if (/alias/i.test(message)) {
      throw new ConfigError([
        issue('YAML_ALIAS_FORBIDDEN', '', 'anchors and aliases are not allowed in configuration'),
      ]);
    }
    throw new ConfigError([
      issue('YAML_SYNTAX', '', 'the document could not be converted to plain data'),
    ]);
  }

  measure(value, limits, 0, { nodes: 0 }, '', issues);
  if (issues.length > 0) throw new ConfigError(issues);

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ConfigError([issue('YAML_NOT_A_MAPPING', '', 'the document root must be a mapping')]);
  }

  return value;
};
