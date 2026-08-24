import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

// The operator's read-only listener publishes an allowlisted projection of its heartbeat, and this
// adapter re-applies an allowlist on the way in. Two lists, two languages, one contract — and the
// only way a mismatch shows up in production is an operator panel that renders blank over a
// perfectly healthy daemon. So the lists are compared here, from source, on both sides.
//
// Rust side: zk/operator/src/health.rs
// TypeScript side: app/api/operator-status/[instanceId]/route.ts

const RUST = new URL('../../../zk/operator/src/health.rs', import.meta.url)
const ROUTE = new URL(
  '../app/api/operator-status/[instanceId]/route.ts',
  import.meta.url
)

/** The string entries of a `const NAME: &[&str] = &[ ... ];` array in the Rust source. */
const rustList = (source: string, name: string): string[] => {
  const start = source.indexOf(`const ${name}: &[&str]`)
  assert.ok(start >= 0, `${name} is missing from health.rs`)
  const open = source.indexOf('&[', start)
  const close = source.indexOf('];', open)
  assert.ok(open >= 0 && close > open, `${name} is not an array literal`)
  return [...source.slice(open, close).matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1])
}

/** Every `input.<key>` / `raw.<key>` / `wanted.<key>` the adapter reads out of the heartbeat. */
const readKeys = (block: string): Set<string> =>
  new Set(
    [...block.matchAll(/\b(?:input|raw|wanted|entry\?)\.([a-z][a-z0-9_]*)/g)].map(
      (m) => m[1]
    )
  )

test('every heartbeat field the adapter reads is one the operator publishes', async () => {
  const rust = await readFile(RUST, 'utf8')
  const route = await readFile(ROUTE, 'utf8')

  const settings = rustList(rust, 'SETTINGS_KEYS')
  const instance = rustList(rust, 'INSTANCE_KEYS')
  const top = rustList(rust, 'TOP_KEYS')
  assert.ok(settings.length > 20, 'the published settings list looks truncated')

  const settingsBlock = route.slice(
    route.indexOf('const sanitizeSettings'),
    route.indexOf('export async function GET')
  )
  assert.ok(settingsBlock.length > 0, 'sanitizeSettings is missing from the route')

  for (const key of readKeys(settingsBlock)) {
    assert.ok(
      settings.includes(key),
      `the adapter reads settings.${key}, which health.rs does not publish`
    )
  }

  const handler = route.slice(route.indexOf('export async function GET'))
  const actionBlock = route.slice(
    route.indexOf('const sanitizeAction'),
    route.indexOf('const sanitizeSettings')
  )
  // `action` is forwarded verbatim, so its inner fields are the Action enum's, not an allowlist.
  const instanceKeys = [...readKeys(handler)].filter(
    (key) => !['instances', 'settings', ...top].includes(key)
  )
  for (const key of instanceKeys) {
    assert.ok(
      instance.includes(key),
      `the adapter reads instance.${key}, which health.rs does not publish`
    )
  }
  for (const key of top) {
    assert.ok(
      handler.includes(`raw.${key}`),
      `health.rs publishes ${key} and nothing reads it`
    )
  }
  assert.ok(actionBlock.includes("'idle'"), 'the action sanitizer lost its vocabulary')
})

test('the adapter never forwards the parts of the heartbeat that are not published', async () => {
  const route = await readFile(ROUTE, 'utf8')
  // These live in status.json on the operator's disk and are deliberately absent from the HTTP
  // body: an alert string can quote a transport error, and a transport error can quote an RPC URL
  // with a provider key in it. If the adapter ever starts reading them, the URL mode and the
  // shared-volume mode have stopped agreeing about what is publishable.
  for (const forbidden of ['raw.alerts', 'raw.unresolved']) {
    assert.ok(
      !route.includes(forbidden),
      `${forbidden} is not published over HTTP and must not be read here either`
    )
  }
})
