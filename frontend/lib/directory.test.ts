import assert from 'node:assert/strict'

import { SECTION_META } from './directory'

assert.equal(SECTION_META['trust-graph'].scoredLabel, 'Scored accounts')

console.log('directory denominator tests passed')
