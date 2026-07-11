/**
 * Runner-agnostic assertions — they throw {@link TestKitAssertionError}, so they work
 * under vitest, node:test, jest, or none. (Native `await expect(p).rejects...` works
 * too; these are for non-vitest runners and for asserting on the thrown error object.)
 */

export class TestKitAssertionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TestKitAssertionError'
  }
}

type ErrorClass<E> = new (...args: never[]) => E

/**
 * Assert the async call rejects with an instance of `errorClass`; returns the caught
 * error (typed) so you can assert further on it. The generated client throws the SAME
 * modeled error classes the server does, so `expectError(() => client.GetX(...), XNotFound)`
 * just works.
 */
export async function expectError<E extends Error>(
  fn: () => Promise<unknown>,
  errorClass: ErrorClass<E>,
): Promise<E> {
  let caught: unknown
  let resolved = false
  try {
    await fn()
    resolved = true
  } catch (e) {
    caught = e
  }
  if (resolved) {
    throw new TestKitAssertionError(`Expected ${errorClass.name} to be thrown, but the call resolved`)
  }
  if (caught instanceof errorClass) return caught
  const got = caught instanceof Error ? `${caught.name}: ${caught.message}` : String(caught)
  throw new TestKitAssertionError(`Expected ${errorClass.name} but got ${got}`)
}

/** Capture the error thrown by an async call (asserts that one IS thrown). */
export async function catchError(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn()
  } catch (e) {
    return e
  }
  throw new TestKitAssertionError('Expected the call to throw, but it resolved')
}

/** Assert a raw {@link Response} (from `app.request`) has the given status; returns it. */
export async function expectStatus(
  fn: () => Promise<Response>,
  status: number,
): Promise<Response> {
  const res = await fn()
  if (res.status !== status) {
    const body = await res.clone().text()
    throw new TestKitAssertionError(`Expected status ${status} but got ${res.status}: ${body}`)
  }
  return res
}
