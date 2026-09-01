import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { productionGoldenV2 } from './production-v2'

writeFileSync(
  fileURLToPath(
    new URL('../../tests/golden/trust-compose-v2.json', import.meta.url)
  ),
  `${JSON.stringify(productionGoldenV2(), null, 2)}\n`
)
