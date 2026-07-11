/**
 * KEY-TOOL --out-file hardening: the secret writer must create a 0600 file, and
 * must refuse a pre-existing target (O_EXCL) or a symlink (O_NOFOLLOW) rather
 * than silently writing the long-lived HMAC secret without protection.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { writeSecretFile } from './secretFile.js'

describe('writeSecretFile (--out-file hardening)', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'key-tool-out-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('creates the file with mode 0600 and the material plus a trailing newline', () => {
    const target = path.join(dir, 'secret.key')
    writeSecretFile(target, 'deadbeef')
    expect(fs.readFileSync(target, 'utf8')).toBe('deadbeef\n')
    // Owner-only rw (0600); mask off the type bits.
    expect(fs.statSync(target).mode & 0o777).toBe(0o600)
  })

  it('refuses to write through a pre-existing file (O_EXCL) — never downgrades its mode', () => {
    const target = path.join(dir, 'exists.key')
    fs.writeFileSync(target, 'pre-existing world-readable', { mode: 0o644 })
    expect(() => writeSecretFile(target, 'secret')).toThrow(/EEXIST/)
    // The original file is untouched — the secret was NOT written into it.
    expect(fs.readFileSync(target, 'utf8')).toBe('pre-existing world-readable')
  })

  it('refuses to follow a symlink at the target path (O_NOFOLLOW)', () => {
    const realTarget = path.join(dir, 'attacker-owned.txt')
    fs.writeFileSync(realTarget, 'attacker file', { mode: 0o644 })
    const link = path.join(dir, 'link.key')
    fs.symlinkSync(realTarget, link)
    // ELOOP on Linux, EMLINK/ENXIO vary by platform — assert it throws and did
    // NOT write the secret through the link into the attacker's file.
    expect(() => writeSecretFile(link, 'secret')).toThrow()
    expect(fs.readFileSync(realTarget, 'utf8')).toBe('attacker file')
  })
})
