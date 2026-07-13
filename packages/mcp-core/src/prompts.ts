/**
 * MCP prompts (§12) — hand-authored, user-controlled message templates surfaced from the
 * generated `MCP_PROMPTS` manifest. Unlike resources (§7), prompts are NOT derived at
 * runtime: the manifest entries ARE the prompts, so there's no `derive*` step. This module
 * mirrors `resources.ts`'s shape — a small list/render pair plus a typed error — and stays
 * web-standard only (ARCH-01): `prompts/get` only string-substitutes `{argName}`
 * placeholders, touching no operation, store, or principal (so no auth gate, §12.3).
 */

import type { McpPrompt, McpPromptArgument } from './types.js'

/**
 * The `prompts/list` payload entry — the spec descriptor shape. Deliberately omits
 * `template`, which is server-internal and must NEVER leak to the client.
 */
export interface McpPromptDescriptor {
  name: string
  title?: string
  description?: string
  arguments: { name: string; description?: string; required: boolean }[]
}

/** Find a prompt by name, or `undefined` — the `prompts/get` lookup. */
export function findPrompt(
  prompts: readonly McpPrompt[],
  name: string,
): McpPrompt | undefined {
  return prompts.find((p) => p.name === name)
}

/**
 * `prompts/list` — map each manifest prompt to its public descriptor. `required` defaults
 * to `false`; `arguments` is always an array (`[]` when none). The `template` is dropped.
 */
export function listPrompts(prompts: readonly McpPrompt[]): McpPromptDescriptor[] {
  return prompts.map((p) => ({
    name: p.name,
    description: p.description,
    arguments: (p.arguments ?? []).map((a) => ({
      name: a.name,
      description: a.description,
      required: a.required ?? false,
    })),
  }))
}

/** A `{argName}` substitution failure → mapped to JSON-RPC `-32602` by the protocol layer. */
export class McpPromptError extends Error {}

/** The single user-text message envelope a `prompts/get` returns. */
export interface PromptResult {
  description?: string
  messages: { role: 'user'; content: { type: 'text'; text: string } }[]
}

/**
 * `prompts/get` — interpolate `{argName}` placeholders in the template (§12.3). For each
 * `{name}` run: a supplied value substitutes its string form; a declared **required** arg
 * absent from `args` throws {@link McpPromptError}; a declared **optional** arg absent
 * substitutes `''`; a placeholder naming no declared arg is left literal (the build-time
 * validator already guards authored templates, so be lenient here). Supplied args the
 * prompt doesn't declare are ignored. Same flat `{name}` convention as the resource URIs —
 * no nesting, no expressions.
 */
export function renderPrompt(
  prompt: McpPrompt,
  args: Record<string, unknown> | undefined,
): PromptResult {
  const supplied = args ?? {}
  const declared = new Map<string, McpPromptArgument>(
    (prompt.arguments ?? []).map((a) => [a.name, a]),
  )
  const text = prompt.template.replace(/\{(\w+)\}/g, (match, key: string) => {
    const decl = declared.get(key)
    // A `{x}` naming no declared arg is left as-is — literal text.
    if (!decl) return match
    if (key in supplied && supplied[key] != null) return String(supplied[key])
    if (decl.required) {
      throw new McpPromptError(`missing required prompt argument: ${key}`)
    }
    // Declared optional arg, absent → empty string.
    return ''
  })
  return {
    description: prompt.description,
    messages: [{ role: 'user', content: { type: 'text', text } }],
  }
}
