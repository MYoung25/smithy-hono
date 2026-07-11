/**
 * Secure sink for freshly generated key material (KEY-TOOL, --out-file hardening).
 *
 * Kept in its own module (not the CLI entrypoint, which runs `main()` on import)
 * so the secure-open behavior is unit-testable in isolation. Lives under src/bin/**
 * — not the key-tool LIBRARY — because it is node-only (`node:fs`); ARCH-01 confines
 * `node:*` to the CLI, and this sink is consumed solely by the CLI (key-tool.ts).
 */

import fs from 'node:fs'

/**
 * Write `material` to `outFile` with an explicit secure open rather than
 * `writeFileSync`'s `mode` option (which is ignored for a pre-existing path and
 * follows symlinks): `O_CREAT|O_EXCL|O_NOFOLLOW, 0600` refuses a pre-existing
 * target or a symlink, so the long-lived HMAC secret is never written through an
 * attacker-planted symlink or into an already world-readable file. A trailing
 * newline is appended. Throws (ENOENT/EEXIST/ELOOP) rather than silently
 * downgrading the protection.
 */
export function writeSecretFile(outFile: string, material: string): void {
  const fd = fs.openSync(
    outFile,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
    0o600,
  )
  try {
    fs.writeSync(fd, material + '\n')
  } finally {
    fs.closeSync(fd)
  }
}
