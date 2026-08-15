import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { buildGolden } from './golden'

writeFileSync(
  fileURLToPath(new URL('./golden.json', import.meta.url)),
  buildGolden()
)
