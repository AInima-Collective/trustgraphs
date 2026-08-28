import { Hono } from 'hono'
import { client, graphql } from 'ponder'
import { db } from 'ponder:api'
import schema from 'ponder:schema'

import account from './account'
import compositions from './compositions'
import contributions from './contributions'
import easOffchain from './eas-offchain'
import erc8004 from './erc8004'
import graphLineages from './graph-lineages'
import hypercerts from './hypercerts'
import instances from './instances'
import merkle from './merkle'
import network from './network'
import nostrWorkspace from './nostr-workspace'
import scorePrograms from './score-programs'
import vault from './vault'
import weightedPriors from './weighted-priors'

const app = new Hono()

app.use('/sql/*', client({ db, schema }))
app.use('/', graphql({ db, schema }))
app.use('/graphql', graphql({ db, schema }))

app.route('/account', account)
app.route('/contributions', contributions)
app.route('/compositions', compositions)
app.route('/erc8004', erc8004)
app.route('/eas-offchain', easOffchain)
app.route('/graph-lineages', graphLineages)
app.route('/hypercerts', hypercerts)
app.route('/instances', instances)
app.route('/merkle', merkle)
app.route('/network', network)
app.route('/nostr-workspace', nostrWorkspace)
app.route('/score-programs', scorePrograms)
app.route('/vault', vault)
app.route('/weighted-priors', weightedPriors)

export default app
