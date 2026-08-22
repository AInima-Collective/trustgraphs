import { createClient } from '@ponder/client'

import * as schema from '../ponder.schema'
import { APIS } from './config'

export const ponderClient = createClient(APIS.ponder + '/sql', {
  schema,
})

declare module '@ponder/react' {
  interface Register {
    schema: typeof schema
  }
}
