import { createRailwayContext, defineRailway } from 'railway/iac'
import { trustgraphsProject } from './lib/project.ts'
import { TARGETS } from './targets.ts'

export default defineRailway((input) => {
  // Railway CLI currently evaluates TypeScript IaC callbacks with a plain input object. Normalize
  // it through the SDK before using helpers such as ctx.shared and ctx.isEnvironment.
  const ctx = createRailwayContext(input)

  // The CLI reports the linked project as ctx.projectName (RAILWAY_IAC_CONTEXT.projectName,
  // verified with CLI 5.52.0). Switching on it is what keeps one chain's parameters out of the
  // other chain's project: an unknown or missing name is an error, never a default.
  const projectName = ctx.projectName
  const target = projectName === undefined ? undefined : TARGETS[projectName]
  if (target === undefined) {
    throw new Error(
      `No Trustgraphs target for Railway project ${
        projectName === undefined ? '(name not reported)' : `"${projectName}"`
      }. Known projects: ${Object.keys(TARGETS).join(', ')}. Run \`railway link\` against one ` +
        'of them; this file never guesses a chain from the project it is pointed at.'
    )
  }

  return trustgraphsProject(ctx, target)
})
