import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { exportedFixture } from './fixture-builder'

const json = JSON.stringify(
  exportedFixture(),
  (_key, value) => (typeof value === 'bigint' ? value.toString() : value),
  2
)

writeFileSync(
  fileURLToPath(new URL('./golden.json', import.meta.url)),
  `${json}\n`
)
