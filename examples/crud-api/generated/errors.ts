export interface SmithyErrorShape {
  readonly $statusCode: number
  readonly $fault: 'client' | 'server'
}

// RT-08 — a global-registry brand stamped on every genuinely-modeled error.
// The security-core errorSanitizer reflects a modeled error's `message` to the
// client ONLY when this brand is present, so a library/internal error that
// merely happens to carry a numeric `$statusCode` cannot leak its message.
export const MODELED_ERROR_BRAND = Symbol.for('@smithy-hono/security-core/modeled-error')

export class SmithyError extends Error implements SmithyErrorShape {
  readonly $statusCode: number
  readonly $fault: 'client' | 'server'

  constructor(message: string, statusCode: number, fault: 'client' | 'server') {
    super(message)
    this.$statusCode = statusCode
    this.$fault = fault
    ;(this as Record<symbol, unknown>)[MODELED_ERROR_BRAND] = true
    Object.setPrototypeOf(this, new.target.prototype)
  }
}
