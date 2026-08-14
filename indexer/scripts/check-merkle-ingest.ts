import { type ScoreBlob, deriveAddressMerkleRows } from '../src/merkle-ingest'

const args = new Map<string, string>()
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i]!, process.argv[i + 1]!)
}
const gateway = args.get('--gateway')
const cid = args.get('--cid')
const root = args.get('--root')
if (!gateway || !cid || !root) {
  throw new Error(
    'usage: check-merkle-ingest --gateway URL --cid CID --root 0xROOT'
  )
}

const response = await fetch(`${gateway}${cid}`)
if (!response.ok)
  throw new Error(`gateway returned ${response.status} for ${cid}`)
const scores = (await response.json()) as ScoreBlob
const result = deriveAddressMerkleRows(scores, root)
if (result.rows.length === 0)
  throw new Error('indexer derived no merkle entry rows')
console.log(
  JSON.stringify({
    cid,
    root: result.computedRoot,
    entries: result.rows.length,
  })
)
