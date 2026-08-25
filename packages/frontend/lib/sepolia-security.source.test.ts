import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(__dirname, '..')
const repositoryRoot = path.resolve(root, '../..')
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8')
const readRepositoryFile = (file: string) =>
  fs.readFileSync(path.join(repositoryRoot, file), 'utf8')

test('public RPC proxy is chain-scoped, read-only, and has two browser transports', () => {
  const route = read('app/api/rpc/[chainId]/route.ts')
  const wagmi = read('lib/wagmi.ts')
  assert.match(route, /allowedChainIds\.has\(chainId\)/)
  assert.match(route, /READ_RPC_METHODS\.has\(req\.method\)/)
  assert.doesNotMatch(route, /['"]eth_sendRawTransaction['"]/)
  assert.match(wagmi, /\/api\/rpc\/\$\{chainId\}\?id=0/)
  assert.match(wagmi, /\/api\/rpc\/\$\{chainId\}\?id=1/)

  const productionPreflight = readRepositoryFile(
    'ops/production-preflight.sh'
  )
  assert.match(productionPreflight, /RPC_URL_11155111_0/)
  assert.match(productionPreflight, /RPC_URL_11155111_1/)
  assert.match(productionPreflight, /must use independent endpoints/)
})

test('public metadata pinning fails closed and spends quota before awaiting upstream work', () => {
  const route = read('app/api/ipfs/route.ts')
  assert.match(route, /publicPinConfigurationError\(\)/)
  assert.match(route, /IPFS_PIN_API must use HTTPS on a public chain/)
  assert.match(route, /originAllowed\(request\)/)
  assert.match(route, /IPFS pin quota exceeded/)
  const increment = route.indexOf('quota.globalCount += 1')
  const firstAwaitAfterQuota = route.indexOf('await alertOnQuota', increment)
  assert.ok(increment > 0 && firstAwaitAfterQuota > increment)
  assert.doesNotMatch(route, /IPFS request failed: \$\{error\.message\}/)
})

test('Sepolia build and wallet UX keep public inputs explicit and switching user-driven', () => {
  const generator = read('scripts/generate-config.ts')
  const wallet = read('components/WalletConnectionProvider.tsx')
  const connectors = read('lib/wallet-connectors.ts')
  const layout = read('app/layout.tsx')
  const create = read('app/create/component.tsx')
  const settings = read('app/networks/[id]/settings/component.tsx')
  assert.match(generator, /const isPublic = stage === ['"]production['"]/)
  assert.match(generator, /requiredPublicUrl\(['"]PONDER_URL['"]\)/)
  assert.match(generator, /requiredPublicUrl\(['"]IPFS_GATEWAY_PUBLIC['"]/)
  assert.doesNotMatch(wallet, /Auto-switch to target network/)
  assert.doesNotMatch(wallet, /useEffect/)
  assert.match(wallet, /switchToTarget/)
  assert.match(connectors, /CHAIN === ['"]sepolia['"] \? \[\] : \[porto\(\)\]/)
  assert.match(layout, /Ethereum Sepolia · Testnet assets have no value/)
  assert.match(create, /vaultAvailable=\{vaultAvailable\}/)
  assert.match(create, /WEIGHTED_PATH_AVAILABLE &&/)
  assert.match(create, /COMPOSITION_PATH_AVAILABLE &&/)
  assert.match(settings, /!realAddress\(CONTRIBUTIONS_FACTORY\)/)
})
