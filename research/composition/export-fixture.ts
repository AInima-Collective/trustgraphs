import { exportedFixture } from './fixture-builder'

const json = JSON.stringify(
  exportedFixture(),
  (_key, value) => (typeof value === 'bigint' ? value.toString() : value),
  2
)

process.stdout.write(`${json}\n`)
