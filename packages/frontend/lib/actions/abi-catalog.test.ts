import assert from 'node:assert/strict'

import { type Address, encodeErrorResult, getAddress, parseAbi } from 'viem'

import {
  decodeKnownCall,
  describeRevertData,
  encodeCustomCall,
  functionSignature,
  knownContractAbis,
  knownContractFor,
  parseAbiText,
  parseFunctionArgument,
  writableFunctions,
} from './abi-catalog'
import { governanceComposerRegistry } from './composer'
import { governanceDangerConsequences } from './danger'
import type { GovernanceActionContext } from './types'

const address = (byte: string) => `0x${byte.repeat(40)}` as Address

const context: GovernanceActionContext = {
  snapshot: address('1'),
  treasurySafe: address('2'),
  fundDistributor: address('3'),
  governanceModule: address('4'),
  recoveryModule: address('5'),
}

// Every network contract in the context has an ABI, and nothing else pretends to.
const known = knownContractAbis(context)
assert.deepEqual(known.map((entry) => entry.label).sort(), [
  'Governance module',
  'Network Safe (treasury)',
  'Network snapshot',
  'Recovery module',
  'Rewards distributor',
])
assert.equal(knownContractFor(context, address('9')), undefined)
assert.equal(
  knownContractFor(context, address('4').toLowerCase())?.label,
  'Governance module'
)

// Only state-changing functions are offered to a proposal.
const governance = knownContractFor(context, address('4'))!
const writable = writableFunctions(governance.abi)
assert.ok(writable.some((fn) => fn.name === 'setQuorum'))
assert.ok(!writable.some((fn) => fn.name === 'quorum'))

// Human-readable and JSON ABIs both parse; a bare signature gets its `function`.
const pasted = parseAbiText(
  'transfer(address to, uint256 amount)\nfunction setOwner(address owner);'
)
assert.deepEqual(writableFunctions(pasted).map(functionSignature), [
  'transfer(address,uint256)',
  'setOwner(address)',
])
assert.equal(
  writableFunctions(
    parseAbiText(
      JSON.stringify([
        {
          type: 'function',
          name: 'ping',
          stateMutability: 'nonpayable',
          inputs: [],
          outputs: [],
        },
      ])
    )
  ).length,
  1
)
assert.throws(() => parseAbiText('   '), /Paste an ABI/)

// Arguments parse by type with messages for people.
assert.equal(parseFunctionArgument({ type: 'uint256' }, '12'), 12n)
assert.throws(() => parseFunctionArgument({ type: 'uint256' }, '1.5'), /whole/)
assert.equal(parseFunctionArgument({ type: 'bool' }, 'true'), true)
assert.throws(() => parseFunctionArgument({ type: 'address' }, 'x'), /address/)
assert.throws(() => parseFunctionArgument({ type: 'bytes32' }, '0x12'), /32/)
assert.deepEqual(
  parseFunctionArgument({ type: 'address[]' }, `["${address('a')}"]`),
  [getAddress(address('a'))]
)
assert.throws(
  () => parseFunctionArgument({ type: 'address[]' }, 'not json'),
  /JSON array/
)

// Building a call from an ABI and reading it back agree.
const transfer = writableFunctions(pasted)[0]!
const data = encodeCustomCall(pasted, transfer, [address('b'), '1000'])
assert.match(data, /^0xa9059cbb/)
const erc20Context: GovernanceActionContext = { fundDistributor: address('3') }
assert.equal(decodeKnownCall(erc20Context, address('9'), data), null)

const setQuorum = writable.find((fn) => fn.name === 'setQuorum')!
const quorumCall = encodeCustomCall(governance.abi, setQuorum, [
  '150000000000000000',
])
const decoded = decodeKnownCall(context, address('4'), quorumCall)
assert.equal(decoded?.contract.label, 'Governance module')
assert.equal(decoded?.functionName, 'setQuorum')
assert.equal(decoded?.args[0]?.value, '150000000000000000')
assert.equal(decodeKnownCall(context, address('4'), '0x1234'), null)

// Reverts decode against the catalog, then the standard Error and Panic.
const custom = encodeErrorResult({
  abi: parseAbi(['error UnknownAction(bytes32 actionId)']),
  errorName: 'UnknownAction',
  args: [`0x${'ab'.repeat(32)}`],
})
assert.match(describeRevertData(context, custom)!, /^UnknownAction\(0xabab/)
const standard = encodeErrorResult({
  abi: parseAbi(['error Error(string)']),
  errorName: 'Error',
  args: ['nope'],
})
assert.equal(describeRevertData(context, standard), 'nope')
assert.equal(describeRevertData(context, '0x'), null)

// Every high-impact action explains its consequence.
for (const definition of governanceComposerRegistry) {
  if (definition.danger) {
    assert.ok(
      governanceDangerConsequences[definition.key],
      `${definition.key} needs a consequence sentence`
    )
  }
}

console.log('governance ABI catalog, custom calls and danger notes: ok')
