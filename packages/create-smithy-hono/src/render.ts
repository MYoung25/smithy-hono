/**
 * Template token substitution. Template files use `{{TOKEN}}` placeholders (chosen
 * to never clash with shell `${...}`, Gradle `${...}`, or JS template literals that
 * legitimately appear verbatim in the emitted files). Pure + unit-tested.
 */

/** The substitution map: token name (without braces) → replacement string. */
export type Substitutions = Record<string, string>

const TOKEN_RE = /\{\{([A-Z0-9_]+)\}\}/g

/**
 * Replace every `{{TOKEN}}` in `content` using `subs`. An unknown token is a hard
 * error — a typo in a template must fail the scaffold loudly rather than ship a
 * literal `{{FOO}}` into a customer's project.
 */
export function render(content: string, subs: Substitutions): string {
  return content.replace(TOKEN_RE, (_match, token: string) => {
    if (!(token in subs)) {
      throw new Error(`template referenced unknown token {{${token}}}`)
    }
    return subs[token]
  })
}

/** True iff `content` contains at least one `{{TOKEN}}`. */
export function hasTokens(content: string): boolean {
  TOKEN_RE.lastIndex = 0
  return TOKEN_RE.test(content)
}
