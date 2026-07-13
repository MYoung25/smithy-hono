/**
 * Minimal zero-dependency interactive prompts over `node:readline`. Two primitives:
 * a free-text `ask` and a numbered `select`. Kept tiny on purpose — a scaffolder
 * should `npx` fast, so we avoid pulling in a prompt library.
 */
import { createInterface, type Interface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'

export interface Choice<T extends string> {
  value: T
  label: string
  hint?: string
}

/** Open a readline interface bound to the process stdio. Caller must `.close()`. */
export function openPrompt(): Interface {
  return createInterface({ input: stdin, output: stdout })
}

/** Ask a free-text question, returning the trimmed answer (or `fallback` if empty). */
export async function ask(rl: Interface, question: string, fallback = ''): Promise<string> {
  const suffix = fallback ? ` (${fallback})` : ''
  const answer = (await rl.question(`${question}${suffix}: `)).trim()
  return answer || fallback
}

/**
 * Present a numbered menu and return the chosen value. Re-asks on invalid input.
 * The first choice is the default (selected on empty input). An optional
 * `description` is printed under the question as a one-line explanation of what the
 * choice controls — this is what turns the prompt into a guided setup step.
 */
export async function select<T extends string>(
  rl: Interface,
  question: string,
  choices: Choice<T>[],
  description?: string,
): Promise<T> {
  stdout.write(`\n${question}\n`)
  if (description) stdout.write(`  ${description}\n`)
  choices.forEach((c, i) => {
    const def = i === 0 ? ' [default]' : ''
    const hint = c.hint ? ` — ${c.hint}` : ''
    stdout.write(`  ${i + 1}) ${c.label}${hint}${def}\n`)
  })
  for (;;) {
    const raw = (await rl.question(`Choose 1-${choices.length}: `)).trim()
    if (raw === '') return choices[0].value
    const n = Number(raw)
    if (Number.isInteger(n) && n >= 1 && n <= choices.length) return choices[n - 1].value
    stdout.write(`Please enter a number between 1 and ${choices.length}.\n`)
  }
}

/**
 * Ask a yes/no question, returning a boolean. `defaultYes` picks which answer an
 * empty input (bare Enter) selects, and is reflected in the `[Y/n]` / `[y/N]` hint.
 * Accepts y/yes/n/no (case-insensitive); re-asks on anything else.
 */
export async function confirm(rl: Interface, question: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? '[Y/n]' : '[y/N]'
  for (;;) {
    const raw = (await rl.question(`${question} ${hint} `)).trim().toLowerCase()
    if (raw === '') return defaultYes
    if (raw === 'y' || raw === 'yes') return true
    if (raw === 'n' || raw === 'no') return false
    stdout.write('Please answer y or n.\n')
  }
}
