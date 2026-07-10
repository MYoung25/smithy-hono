#!/usr/bin/env node
/**
 * `key-tool` CLI (OPS-03) — a thin, node-only wrapper over the lifecycle library.
 *
 * Node APIs (argv, stdout, dynamic `ioredis` import) are confined to THIS file;
 * the lifecycle/keygen library stays web-standard and portable. The CLI wires the
 * Node Redis backend end-to-end (the adapter with a live conformance test).
 *
 * Usage:
 *   key-tool provision <clientId> [--redis-url <url>] [--secret-bytes N] [--key-id <id>]
 *   key-tool rotate    <clientId> [--redis-url <url>] [--secret-bytes N] [--new-key-id <id>]
 *   key-tool revoke-previous <clientId> [--redis-url <url>]
 *   key-tool revoke    <clientId> [--redis-url <url>]
 *   key-tool current   <clientId> [--redis-url <url>]
 *
 * The Redis URL is taken from --redis-url or $REDIS_URL. Provision/rotation/revocation
 * emit a `key.rotate` audit line to stdout (the Node stdout audit sink) so a log
 * shipper captures them. The new/initial base64 material is the long-lived signing
 * secret; to keep it OFF the log-shipped stdout (fd 1) it is written to stderr (fd 2)
 * by default, or to a 0600 file via `--out-file`. stdout carries only non-secret
 * result fields (clientId/keyId/...). Distribute the material to the client over a
 * secure channel; it is never recoverable from the backend.
 */

import process from 'node:process'
import { writeSecretFile } from './secretFile.js'
import {
  provisionClient,
  rotateClient,
  revokePreviousKey,
  revokeClient,
  type LifecycleAudit,
  type WritableKeyBackend,
} from '../index.js'

interface ParsedArgs {
  command: string
  clientId: string | undefined
  flags: Record<string, string>
  bools: Set<string>
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv
  const flags: Record<string, string> = {}
  const bools = new Set<string>()
  let clientId: string | undefined
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i]
    if (tok.startsWith('--')) {
      const name = tok.slice(2)
      const next = rest[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        flags[name] = next
        i++
      } else {
        bools.add(name)
      }
    } else if (clientId === undefined) {
      clientId = tok
    }
  }
  return { command: command ?? '', clientId, flags, bools }
}

const USAGE = `key-tool — S2S signing-key lifecycle (OPS-03)

Commands:
  provision <clientId>         Onboard a new client (generate + write key, set current).
  rotate <clientId>            Rotate to a new key, keeping the previous in the overlap window.
  revoke-previous <clientId>   Delete the previous key's material (close the overlap window).
  revoke <clientId>            Revoke the client entirely (delete all material).
  current <clientId>           Print the client's current/previous keyIds.

Common flags:
  --redis-url <url>    Redis connection URL (default: $REDIS_URL).
  --secret-bytes <n>   Generated secret length in bytes (default: 32, min: 16).
  --key-id <id>        Explicit keyId for provision.
  --new-key-id <id>    Explicit keyId for rotate.
  --out-file <path>    Write the secret material to <path> (mode 0600) instead of stderr.
                       The target MUST NOT already exist and MUST NOT be a symlink.

Material is emitted once on provision/rotate to stderr (or --out-file, mode 0600) —
NOT to stdout, so it stays off the log-shipped fd. Distribute it securely.`

/**
 * Emit the freshly generated secret material OFF the log-shipped stdout (fd 1).
 * With `--out-file`, write it to a 0600 file and print only the path to stderr;
 * otherwise write the raw material to stderr (fd 2). stdout carries only the
 * non-secret JSON result (KEY-TOOL-04).
 *
 * The file is created with an explicit secure open rather than `writeFileSync`'s
 * `mode` option (which is ignored for a pre-existing path and follows symlinks):
 * `O_CREAT|O_EXCL|O_NOFOLLOW, 0600` refuses a pre-existing target or a symlink, so
 * the long-lived HMAC secret is never written through an attacker-planted symlink or
 * into an already world-readable file (KEY-TOOL, --out-file hardening).
 */
function emitMaterial(material: string, outFile: string | undefined): void {
  if (outFile) {
    writeSecretFile(outFile, material)
    process.stderr.write(`material written to ${outFile} (mode 0600)\n`)
  } else {
    process.stderr.write(material + '\n')
  }
}

/** Build the Node Redis backend + a stdout audit sink via dynamic adapter imports. */
async function buildRedisBackend(
  redisUrl: string,
): Promise<{ backend: WritableKeyBackend; audit: LifecycleAudit; close(): Promise<void> }> {
  // Dynamic imports keep the CLI loadable for --help even without these installed.
  const { default: Redis } = (await import('ioredis')) as unknown as {
    default: new (url: string) => {
      get(key: string): Promise<string | null>
      set(key: string, value: string, ...args: (string | number)[]): Promise<string | null>
      del(key: string): Promise<number>
      pexpire(key: string, ms: number): Promise<number>
      eval(script: string, numKeys: number, ...a: (string | number)[]): Promise<unknown>
      quit(): Promise<unknown>
    }
  }
  const adapter = await import('@smithy-hono/adapter-node')
  const client = new Redis(redisUrl)
  const port = adapter.createRedisPort(client)
  const backend = new adapter.RedisKeyBackend(port)
  const sink = adapter.createStdoutAuditSink({ base: { source: 'key-tool' } })
  return {
    backend,
    audit: { sink, requestId: 'key-tool', principalRef: null },
    async close() {
      await client.quit()
    },
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))

  if (
    args.command === '' ||
    args.command === 'help' ||
    args.command === '--help' ||
    args.command === '-h' ||
    args.bools.has('help')
  ) {
    process.stdout.write(USAGE + '\n')
    return 0
  }

  const redisUrl = args.flags['redis-url'] ?? process.env.REDIS_URL
  if (!redisUrl) {
    process.stderr.write('error: --redis-url or $REDIS_URL is required\n')
    return 2
  }
  if (!args.clientId) {
    process.stderr.write(`error: <clientId> is required for '${args.command}'\n`)
    return 2
  }

  const { backend, audit, close } = await buildRedisBackend(redisUrl)
  try {
    switch (args.command) {
      case 'provision': {
        const res = await provisionClient(
          backend,
          {
            clientId: args.clientId,
            keyId: args.flags['key-id'],
            secretBytes: args.flags['secret-bytes']
              ? Number(args.flags['secret-bytes'])
              : undefined,
          },
          audit,
        )
        // Material goes to stderr/--out-file (off the log-shipped fd); stdout gets
        // only non-secret fields.
        emitMaterial(res.material, args.flags['out-file'])
        process.stdout.write(
          JSON.stringify(
            { action: 'provision', clientId: res.clientId, keyId: res.keyId },
            null,
            2,
          ) + '\n',
        )
        return 0
      }
      case 'rotate': {
        const res = await rotateClient(
          backend,
          {
            clientId: args.clientId,
            newKeyId: args.flags['new-key-id'],
            secretBytes: args.flags['secret-bytes']
              ? Number(args.flags['secret-bytes'])
              : undefined,
          },
          audit,
        )
        // Material goes to stderr/--out-file (off the log-shipped fd); stdout gets
        // only non-secret fields.
        emitMaterial(res.material, args.flags['out-file'])
        process.stdout.write(
          JSON.stringify(
            {
              action: 'rotate',
              clientId: res.clientId,
              newKeyId: res.newKeyId,
              previousKeyId: res.previousKeyId,
            },
            null,
            2,
          ) + '\n',
        )
        return 0
      }
      case 'revoke-previous': {
        const res = await revokePreviousKey(backend, args.clientId, audit)
        process.stdout.write(JSON.stringify({ action: 'revoke-previous', ...res }, null, 2) + '\n')
        return 0
      }
      case 'revoke': {
        const res = await revokeClient(backend, args.clientId, audit)
        process.stdout.write(JSON.stringify({ action: 'revoke', ...res }, null, 2) + '\n')
        return 0
      }
      case 'current': {
        const entry = await backend.getDirectoryEntry(args.clientId)
        process.stdout.write(JSON.stringify({ clientId: args.clientId, entry }, null, 2) + '\n')
        return 0
      }
      default:
        process.stderr.write(`error: unknown command '${args.command}'\n\n${USAGE}\n`)
        return 2
    }
  } finally {
    await close()
  }
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((err: unknown) => {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exitCode = 1
  })
