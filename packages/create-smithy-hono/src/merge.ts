/**
 * Deep-merge for the layered `package.json` fragments each template layer
 * contributes. Objects merge recursively; arrays concatenate with de-duplication
 * (so `workspaces`/`files` accumulate without repeats); scalars from a later layer
 * win. Pure + unit-tested — no filesystem here.
 */

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json }

function isPlainObject(v: Json): v is { [k: string]: Json } {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Merge `patch` into `base`, returning a new value (inputs are not mutated).
 * - two plain objects → key-wise deep merge
 * - two arrays → concat, then drop duplicate primitives (objects kept as-is)
 * - anything else → `patch` replaces `base`
 */
export function deepMerge(base: Json, patch: Json): Json {
  if (isPlainObject(base) && isPlainObject(patch)) {
    const out: { [k: string]: Json } = { ...base }
    for (const [k, v] of Object.entries(patch)) {
      out[k] = k in base ? deepMerge(base[k], v) : v
    }
    return out
  }
  if (Array.isArray(base) && Array.isArray(patch)) {
    const combined = [...base, ...patch]
    const seen = new Set<string>()
    const out: Json[] = []
    for (const item of combined) {
      if (typeof item === 'object' && item !== null) {
        out.push(item)
        continue
      }
      const key = JSON.stringify(item)
      if (seen.has(key)) continue
      seen.add(key)
      out.push(item)
    }
    return out
  }
  return patch
}

/** Reduce a list of package.json fragments (in layer order) into one object. */
export function mergeAll(fragments: Json[]): Json {
  return fragments.reduce<Json>((acc, frag) => deepMerge(acc, frag), {})
}
