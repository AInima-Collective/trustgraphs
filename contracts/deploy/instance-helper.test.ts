import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

type AbiInput = {
  type: string
  indexed?: boolean
  components?: AbiInput[]
}

type AbiEvent = {
  type: 'event'
  name: string
  inputs: AbiInput[]
}

function canonicalType(input: AbiInput): string {
  if (!input.type.startsWith('tuple')) return input.type

  assert.ok(input.components, 'tuple ABI input has no components')
  const suffix = input.type.slice('tuple'.length)
  return `(${input.components.map(canonicalType).join(',')})${suffix}`
}

function shellConstant(source: string, name: string): string {
  const match = source.match(new RegExp(`^${name}='([^']+)'$`, 'm'))
  assert.ok(match, `${name} is missing from taskfile/lib/instance.sh`)
  return match[1]
}

test('demo instance resolver matches the generated InstanceCreated ABI', () => {
  const helper = fs.readFileSync('taskfile/lib/instance.sh', 'utf8')
  const artifact = JSON.parse(
    fs.readFileSync('packages/frontend/abis/TrustgraphsFactory.json', 'utf8')
  ) as { abi: Array<AbiEvent | { type: string; name?: string }> }
  const event = artifact.abi.find(
    (item): item is AbiEvent =>
      item.type === 'event' && item.name === 'InstanceCreated'
  )
  assert.ok(event, 'TrustgraphsFactory ABI has no InstanceCreated event')

  const eventSignature = `InstanceCreated(${event.inputs
    .map((input) => `${canonicalType(input)}${input.indexed ? ' indexed' : ''}`)
    .join(',')})`
  const decoder = `x()(${event.inputs
    .filter((input) => !input.indexed)
    .map(canonicalType)
    .join(',')})`

  assert.equal(shellConstant(helper, 'INSTANCE_SIG'), eventSignature)
  assert.equal(shellConstant(helper, 'INSTANCE_DEC'), decoder)
})
