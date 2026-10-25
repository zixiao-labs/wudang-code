import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import protobuf from 'protobufjs'

// Embed the canonical protocol so packaged Electron never depends on a source checkout.
const root = await new protobuf.Root().load(
  ['auth', 'repository', 'collab'].map((name) =>
    fileURLToPath(new URL(`../../../../proto/${name}.proto`, import.meta.url)),
  ),
)
root.resolveAll()
const descriptor = JSON.stringify(root.toJSON(), (_key, value) =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(
        Object.entries(value).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
      )
    : value,
)
const output = `// Generated from proto/*.proto. Run pnpm protocol:generate; do not edit.\nexport default ${descriptor}\n`
const destination = new URL('../src/electron/protocol.ts', import.meta.url)
if (process.argv.includes('--check')) {
  if ((await readFile(destination, 'utf8')) !== output) {
    throw new Error('Protocol is stale. Run pnpm protocol:generate.')
  }
} else {
  await writeFile(destination, output)
}
