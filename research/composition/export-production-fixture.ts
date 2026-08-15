import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { productionGolden } from './production'

writeFileSync(
  fileURLToPath(
    new URL('../../test/golden/trust-compose.json', import.meta.url)
  ),
  `${JSON.stringify(productionGolden(), null, 2)}\n`
)
