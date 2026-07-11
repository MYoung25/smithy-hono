/**
 * Prompt unit tests (§12.8): `listPrompts` shapes the public descriptors (NEVER leaking
 * `template`, defaulting `required` to false); `renderPrompt` interpolates `{argName}`
 * placeholders — all args supplied, optional missing → `''`, required missing → throws
 * `McpPromptError`, an undeclared supplied arg ignored, and literal/non-placeholder braces
 * preserved. No dispatch, no protocol.
 */

import { describe, it, expect } from 'vitest'
import { listPrompts, renderPrompt, McpPromptError, type McpPrompt } from './index.js'

const triage: McpPrompt = {
  name: 'triage-tasks',
  description: 'Review the open tasks and propose a prioritization.',
  arguments: [{ name: 'focus', description: 'Area to prioritize', required: false }],
  template: 'Propose a priority order. Focus on: {focus}.',
}

const createTask: McpPrompt = {
  name: 'create-task',
  description: 'Draft a new task from a note.',
  arguments: [{ name: 'body', required: true }],
  template: 'Create a task from this note: {body}. Leave done=false.',
}

describe('listPrompts', () => {
  it('emits the spec descriptor shape and never leaks the template', () => {
    const [d] = listPrompts([triage])
    expect(d).toEqual({
      name: 'triage-tasks',
      description: 'Review the open tasks and propose a prioritization.',
      arguments: [{ name: 'focus', description: 'Area to prioritize', required: false }],
    })
    expect('template' in d).toBe(false)
  })

  it('defaults a missing `required` to false', () => {
    const p: McpPrompt = { name: 'p', arguments: [{ name: 'x' }], template: '{x}' }
    expect(listPrompts([p])[0].arguments).toEqual([{ name: 'x', description: undefined, required: false }])
  })

  it('renders an empty arguments array when a prompt declares none', () => {
    const p: McpPrompt = { name: 'p', template: 'hello' }
    expect(listPrompts([p])[0].arguments).toEqual([])
  })
})

describe('renderPrompt', () => {
  it('substitutes all supplied args into a single user-text message', () => {
    const r = renderPrompt(createTask, { body: 'buy milk' })
    expect(r.description).toBe('Draft a new task from a note.')
    expect(r.messages).toEqual([
      { role: 'user', content: { type: 'text', text: 'Create a task from this note: buy milk. Leave done=false.' } },
    ])
  })

  it('substitutes a missing OPTIONAL arg with the empty string', () => {
    const r = renderPrompt(triage, undefined)
    expect(r.messages[0].content.text).toBe('Propose a priority order. Focus on: .')
  })

  it('throws McpPromptError when a REQUIRED arg is absent', () => {
    expect(() => renderPrompt(createTask, undefined)).toThrow(McpPromptError)
    expect(() => renderPrompt(createTask, {})).toThrow(/missing required prompt argument: body/)
  })

  it('ignores a supplied arg the prompt does not declare', () => {
    const r = renderPrompt(createTask, { body: 'note', extra: 'unused' })
    expect(r.messages[0].content.text).toContain('note')
    expect(r.messages[0].content.text).not.toContain('unused')
  })

  it('leaves a placeholder naming no declared arg as literal text', () => {
    const p: McpPrompt = { name: 'p', arguments: [{ name: 'a' }], template: 'a={a} b={b}' }
    expect(renderPrompt(p, { a: '1' }).messages[0].content.text).toBe('a=1 b={b}')
  })

  it('preserves non-placeholder braces', () => {
    const p: McpPrompt = { name: 'p', template: 'leave {} and {  } alone' }
    expect(renderPrompt(p, {}).messages[0].content.text).toBe('leave {} and {  } alone')
  })
})
