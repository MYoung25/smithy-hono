/**
 * RT-13 / LOG-03 — `@sensitive` field redaction.
 *
 * The generated metadata registry carries machine-readable `sensitiveFields` (dot-
 * paths of `@sensitive` input/output members). This module scrubs those paths from a
 * model-derived value BEFORE it is logged or placed in an audit `detail`, so a
 * `@sensitive` field (password, token, PII) never reaches a sink.
 *
 * The request logger is safe-by-construction today (it logs a fixed field set, never
 * bodies), so this is the redaction SEAM for any code path that does log model data.
 *
 * Web-standard only (ARCH-01): no `node:*`, no `Buffer`.
 */

/** The marker substituted for a redacted value. */
export const REDACTED = '[REDACTED]'

/**
 * Return a deep copy of {@link value} with every path in {@link paths} replaced by
 * {@link REDACTED}. Paths are dot-separated (`"body.password"`); a segment that
 * crosses an array applies to every element (so `"items.token"` scrubs `token` on
 * each element of `items`). Unknown paths are ignored. The input is never mutated.
 *
 * @param value the model-derived value to scrub (object/array/primitive).
 * @param paths `@sensitive` dot-paths, e.g. `op.sensitiveFields`.
 */
export function redactSensitive<T>(value: T, paths: readonly string[] | undefined): T {
  if (!paths || paths.length === 0) return value
  if (value === null || typeof value !== 'object') return value

  // Deep clone so the caller's object is never mutated, then scrub in place.
  const clone = structuredClone(value)
  for (const path of paths) {
    const segments = path.split('.').filter((s) => s.length > 0)
    if (segments.length > 0) redactPath(clone, segments)
  }
  return clone
}

/**
 * Segment names that would let a malicious path walk into / mutate the prototype
 * chain (`__proto__.toString`, `constructor.prototype`, …). A Smithy member named
 * `__proto__` is a valid identifier, so a generated `sensitiveFields` path could
 * carry one; descending into these would clobber shared `Object.prototype` methods.
 * They are never legitimate own-property field names, so we refuse to descend.
 */
const UNSAFE_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype'])

/** Walk {@link segments} into {@link node}, redacting the leaf (descending into arrays). */
function redactPath(node: unknown, segments: readonly string[]): void {
  if (node === null || typeof node !== 'object') return

  // An array distributes the remaining path over every element.
  if (Array.isArray(node)) {
    for (const item of node) redactPath(item, segments)
    return
  }

  const obj = node as Record<string, unknown>
  const [head, ...rest] = segments
  // Prototype-pollution guard: never follow a segment that escapes into the
  // prototype chain, and require the key to be an OWN property (the `in` operator
  // walks the prototype, so it would otherwise match inherited members).
  if (head === undefined || UNSAFE_SEGMENTS.has(head)) return
  if (!Object.prototype.hasOwnProperty.call(obj, head)) return

  if (rest.length === 0) {
    obj[head] = REDACTED
  } else {
    redactPath(obj[head], rest)
  }
}
