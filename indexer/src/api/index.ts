import { Hono } from 'hono'
import { client, graphql } from 'ponder'
import { db } from 'ponder:api'
import schema from 'ponder:schema'

import account from './account'
import attestations from './attestations'
import contributions from './contributions'
import hypercerts from './hypercerts'
import localismFund from './localism-fund'
import merkle from './merkle'
import network from './network'

const app = new Hono()

app.use('/sql/*', client({ db, schema }))
app.use('/', graphql({ db, schema }))
app.use('/graphql', graphql({ db, schema }))

app.route('/account', account)
app.route('/attestations', attestations)
app.route('/contributions', contributions)
app.route('/hypercerts', hypercerts)
app.route('/merkle', merkle)
app.route('/network', network)

app.route('/localism-fund', localismFund)

export default app
