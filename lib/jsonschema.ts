/**
 * The JSON Schema primitives every generator builds its schema from.
 *
 * These lived inside lib/studypack/schema.ts, where they were written for the
 * study pack's own block union. The lesson has its own vocabulary and the same
 * strict-mode constraints, and importing the pack's module to get `obj()` would
 * pull the whole pack content model along with it. So the primitives move here
 * and both import them. Nothing about them changed in the move.
 *
 * WHY THEY EXIST AT ALL. Structured output in strict mode is unforgiving in two
 * specific ways, on both providers:
 *   1. Every property must appear in `required`. There is no such thing as an
 *      optional field, so a field that may be absent is typed nullable instead.
 *   2. `additionalProperties` must be false.
 * Writing that out by hand for forty block shapes is where a schema goes wrong
 * quietly, so `obj()` derives `required` from the properties it was given and
 * a field can never be forgotten.
 *
 * What is NOT supported and must not be added: `minimum`, `maximum`, `maxItems`,
 * `minItems`, `pattern`. Both providers reject or ignore them under strict mode,
 * so every count and bound in this codebase is enforced in code after parsing
 * (see lib/lesson/repair.ts and lib/studypack/generate.ts).
 */

export type JSchema = Record<string, unknown>;

/** Strict-mode object: every property required, no extras. */
export function obj(properties: Record<string, JSchema>): JSchema {
  return {
    type: 'object', additionalProperties: false,
    required: Object.keys(properties), properties,
  };
}

export const str: JSchema = { type: 'string' };
export const nstr: JSchema = { type: ['string', 'null'] };
export const int: JSchema = { type: 'integer' };
export const nint: JSchema = { type: ['integer', 'null'] };
export const num: JSchema = { type: 'number' };
export const nnum: JSchema = { type: ['number', 'null'] };
export const bool: JSchema = { type: 'boolean' };

export const arr = (items: JSchema): JSchema => ({ type: 'array', items });

/** A single-value string enum - how a discriminated union names its variant. */
export const lit = (v: string): JSchema => ({ type: 'string', enum: [v] });

/** A closed set of strings. */
export const oneOf = (values: readonly string[]): JSchema => ({ type: 'string', enum: [...values] });
