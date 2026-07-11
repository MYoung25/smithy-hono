/**
 * Test-support entrypoint: the in-process fake {@link RedisPort}.
 *
 * Exposed as a subpath export so downstream packages (e.g. `examples/`) can wire
 * the Redis-backed stores against the fake port in their own tests without a live
 * server. The fake honors the SAME atomicity contract as real Redis synchronously
 * (single JS tick == atomic), which is exactly what lets the stores pass the
 * security-core conformance suites locally.
 */

export { createFakeRedisPort } from './ports.js'
