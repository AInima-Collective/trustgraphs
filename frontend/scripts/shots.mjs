#!/usr/bin/env node
/**
 * The review harness: agents cannot review a design they cannot see.
 *
 * Walks a matrix of route × viewport × theme against a PRODUCTION build and
 * writes PNGs to `.trustgraph/shots/<label>/`. Two shots per cell: the fold
 * (what a visitor actually gets) and the full page (what the layout does all
 * the way down). A third, `__open.png`, on any route that hides content behind
 * a `<details>` — which is /faq, where the answers are two thirds of the page.
 *
 *   pnpm run shots                    # the three public routes, full matrix
 *   pnpm run shots -- --states        # the four directory states as well
 *   pnpm run shots -- --label=final   # write somewhere other than `latest`
 *   pnpm run shots -- --reuse         # skip the build, reuse .next-shots
 *   pnpm run shots -- --routes=/faq   # one route, whole matrix
 *
 * ── Three things this has to work around ─────────────────────────────────────
 *
 * 1. IT MUST NOT USE `next dev`. The dev server OOMs in this box partway
 *    through a multi-route sweep, and a dev-mode screenshot is not what ships
 *    anyway. Everything below runs `next build` + `next start` against
 *    NEXT_DIST_DIR=.next-shots, so a dev server someone left running keeps its
 *    own `.next` untouched.
 *
 * 2. PLAYWRIGHT IS INSTALLED GLOBALLY, not in the frontend's node_modules.
 *    Hence NODE_PATH below. The browsers are already in ~/.cache/ms-playwright.
 *
 * 3. A LEAKED SERVER WILL SILENTLY REVIEW THE WRONG BUILD. This one cost two
 *    sweeps. `next start` is three processes deep under `npx`, so killing the
 *    child we spawned used to orphan the node process holding the port; the
 *    next run then found "something answering" and screenshotted the PREVIOUS
 *    build, whose HTML referenced a CSS chunk from a dist directory since
 *    deleted. Every shot came out as unstyled HTML that still looks like a page
 *    in a thumbnail. Two guards now: the run refuses to start if the port is
 *    busy, and the server is killed by process group. The `cssRules === 0`
 *    check is the backstop for whatever else can produce a naked page.
 *
 * 4. THE FOUR DIRECTORY STATES ARE BUILD-TIME, NOT REQUEST-TIME. `/networks`
 *    is a statically prerendered ISR route, so the HTML that `next start`
 *    serves first was rendered during `next build`. Switching the fixture and
 *    restarting the server would screenshot the previous state's cache. So each
 *    state gets its own build (see `TG_FIXTURE` in lib/directory.fixtures.ts) and
 *    only shoots `/networks`, at the two viewports M2 is graded on.
 */
import { spawn } from 'node:child_process'
import { mkdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Playwright is installed GLOBALLY, not in the frontend's node_modules, and an
// ESM `import` does not consult NODE_PATH — only CommonJS resolution does. So
// it is required rather than imported, with the global prefix as the fallback
// for a shell that did not export NODE_PATH.
const require = createRequire(import.meta.url)
const loadPlaywright = () => {
  try {
    return require('playwright')
  } catch {
    return require('/usr/lib/node_modules/playwright')
  }
}
const { chromium } = loadPlaywright()

const FRONTEND = join(dirname(fileURLToPath(import.meta.url)), '..')
const REPO = join(FRONTEND, '..')
const PORT = Number(process.env.SHOTS_PORT || 3789)
const ORIGIN = `http://127.0.0.1:${PORT}`

/** 390 is the design target, not the adaptation, so it leads. 320 is the stress case. */
const VIEWPORTS = [
  { name: '320', width: 320, height: 720 },
  { name: '390', width: 390, height: 844 },
  { name: '414', width: 414, height: 896 },
  { name: '768', width: 768, height: 1024 },
  { name: '1280', width: 1280, height: 900 },
  { name: '1600', width: 1600, height: 1000 },
]

const THEMES = ['dark', 'light']

const ROUTES = [
  { name: 'home', path: '/' },
  { name: 'networks', path: '/networks' },
  { name: 'faq', path: '/faq' },
]

/** What `lib/directory.fixtures.ts` understands. `live` means "no fixture, read the indexer". */
const STATES = ['many', 'one', 'none', 'failed']
const STATE_VIEWPORTS = ['390', '1280']

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`))
  if (!hit) return fallback
  const [, value] = hit.split('=')
  return value === undefined ? true : value
}

const LABEL = String(flag('label', 'latest'))
const REUSE = Boolean(flag('reuse', false))
const WITH_STATES = Boolean(flag('states', false))
const REDUCED_MOTION = Boolean(flag('reduced-motion', false))
const ONLY_ROUTES = flag('routes', null)

const routes = ONLY_ROUTES
  ? ROUTES.filter((r) => String(ONLY_ROUTES).split(',').includes(r.path))
  : ROUTES

const OUT = join(REPO, '.trustgraph', 'shots', LABEL)

// Scoped to the label so two sweeps can run at once without building into each
// other's output. Pair it with SHOTS_PORT when you do.
const DIST = `.next-shots-${LABEL}`

const log = (...args) => console.log('[shots]', ...args)

const run = (command, args, { env = {}, quiet = false } = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: FRONTEND,
      env: { ...process.env, ...env },
      stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    })
    let tail = ''
    if (quiet) {
      const keep = (chunk) => {
        tail = (tail + chunk).slice(-4000)
      }
      child.stdout.on('data', keep)
      child.stderr.on('data', keep)
    }
    child.on('error', reject)
    child.on('exit', (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(`${command} ${args.join(' ')} exited ${code}\n${tail}`)
          )
    )
  })

/**
 * `next build`, not `pnpm run build`.
 *
 * The `prebuild` hook regenerates the wagmi bindings, which needs a
 * platform-matched esbuild and fails in this sandbox. The generated files are
 * checked in and current, and nothing this harness does can invalidate them,
 * so the hook is skipped deliberately rather than by accident.
 */
const build = (fixture) =>
  run('npx', ['next', 'build'], {
    env: {
      NEXT_DIST_DIR: DIST,
      ...(fixture ? { TG_FIXTURE: fixture } : {}),
    },
    quiet: true,
  })

/**
 * Refuse to run against somebody else's server.
 *
 * This cost two sweeps. `startServer` used to poll the port and treat "something
 * answered" as "my server is up" — so when a previous run leaked a `next start`
 * that was still holding the port, every screenshot was of the PREVIOUS build.
 * The symptom was a matrix of unstyled pages, because that older build's HTML
 * referenced a CSS chunk that only existed in a dist directory since deleted.
 * A stale server is indistinguishable from a healthy one at the socket level,
 * so the only safe move is to insist the port is free before we begin.
 */
const requireFreePort = async () => {
  try {
    await fetch(ORIGIN, { redirect: 'manual' })
  } catch {
    return // nothing listening, which is what we want
  }
  throw new Error(
    `Something is already listening on ${ORIGIN}. Refusing to run: the sweep ` +
      `would screenshot that server's build rather than this one. Stop it ` +
      `(\`pkill -f "next start --port ${PORT}"\`) or pass SHOTS_PORT=<other>.`
  )
}

const startServer = async (fixture) => {
  const child = spawn('npx', ['next', 'start', '--port', String(PORT)], {
    cwd: FRONTEND,
    env: {
      ...process.env,
      NEXT_DIST_DIR: DIST,
      ...(fixture ? { TG_FIXTURE: fixture } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    // Its own process group. `npx next start` is three processes deep, and
    // signalling only the one we spawned orphans the node process that actually
    // holds the port — which is how the stale server above got there.
    detached: true,
  })
  let output = ''
  child.stdout.on('data', (c) => (output += c))
  child.stderr.on('data', (c) => (output += c))

  const deadline = Date.now() + 90_000
  for (;;) {
    if (Date.now() > deadline) {
      stopServer(child)
      throw new Error(`next start never came up:\n${output}`)
    }
    try {
      const response = await fetch(ORIGIN, { redirect: 'manual' })
      if (response.status < 500) break
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 400))
  }
  return child
}

/** Kill the whole group, so nothing survives to poison the next run. */
const stopServer = (child) => {
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    try {
      child.kill('SIGKILL')
    } catch {
      /* already gone */
    }
  }
}

/**
 * One cell of the matrix.
 *
 * The theme is stamped into localStorage before any page script runs, because
 * next-themes reads it in an inline script during first paint — navigating and
 * then toggling would screenshot a flash of the wrong theme.
 */
const shoot = async (browser, { route, viewport, theme, dir, tag }) => {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: 2,
    ...(REDUCED_MOTION ? { reducedMotion: 'reduce' } : {}),
  })
  await context.addInitScript(
    ([key, value]) => {
      try {
        window.localStorage.setItem(key, value)
      } catch {
        /* storage blocked, the default theme is fine */
      }
    },
    ['theme', theme]
  )

  const page = await context.newPage()
  const problems = []
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text())
  })
  page.on('pageerror', (error) => problems.push(String(error)))

  // `domcontentloaded`, NOT `networkidle`. With no indexer answering, the app's
  // react-query retries mean the network never goes idle, so `networkidle` just
  // burns its timeout and then throws. The real settle signal is `data-settling`
  // below, which the components own and which does not depend on the network
  // ever going quiet.
  const response = await page.goto(`${ORIGIN}${route.path}`, {
    waitUntil: 'domcontentloaded',
    timeout: 45_000,
  })

  // Wait for every live module to reach a terminal state before shooting.
  // Components that are still fetching or laying out mark themselves with
  // `data-settling`; a review matrix full of spinners tells you nothing about
  // the design, and worse, hides whatever the module says when its data never
  // arrives.
  //
  // TWO PHASES, and the first one is not optional. A module behind a dynamic
  // `ssr: false` import is absent from the server HTML, so checking for the
  // marker on arrival finds none, concludes "settled", and shoots the spinner
  // that mounts a moment later. So: give anything that is going to declare
  // itself a short window to do so, THEN wait for it to clear. Both phases
  // swallow their timeout, because a module that never settles is a finding the
  // reviewer should see rather than an error that loses the whole sweep.
  await page
    .waitForSelector('[data-settling]', { timeout: 2_500 })
    .catch(() => {})
  await page
    .waitForFunction(() => !document.querySelector('[data-settling]'), null, {
      timeout: 20_000,
    })
    .catch(() => {})

  // Then the force-atlas pass, which runs 250ms and stops.
  await page.waitForTimeout(900)

  const base = tag
    ? `${route.name}__${tag}__${viewport.name}__${theme}`
    : `${route.name}__${viewport.name}__${theme}`

  await page.screenshot({ path: join(dir, `${base}__fold.png`) })
  await page.screenshot({
    path: join(dir, `${base}__full.png`),
    fullPage: true,
  })

  // A THIRD SHOT WHEREVER THE PAGE HIDES ITS OWN CONTENT BEHIND A DISCLOSURE.
  //
  // Every `<details>` on /faq ships closed, which is correct for a reader and
  // useless for a review: the answers, their measure, their link colour and the
  // open-state marker were invisible in all 24 FAQ cells of a sweep, so a lane
  // reading only the matrix was grading the questions and none of the answers.
  // A whole third of that page's ink had never been looked at.
  //
  // Opened by setting the attribute rather than by clicking: fifteen clicks is
  // fifteen chances to miss a hit target, and `open` is exactly what a click
  // sets. No-ops on any route with no disclosures, so it stays in the main loop.
  const opened = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('details'))
    all.forEach((d) => d.setAttribute('open', ''))
    return all.length
  })
  if (opened > 0) {
    await page.waitForTimeout(200)
    await page.screenshot({
      path: join(dir, `${base}__open.png`),
      fullPage: true,
    })
  }

  const measured = await page.evaluate(() => {
    // A page that scrolls sideways at 320 is a defect the screenshot cannot
    // show, because the screenshot is the width of the viewport. Measure it.
    //
    // The stylesheet check is here because of a real incident: a build taken
    // while a source file was being edited emitted a <link> to a CSS chunk that
    // was never written, the chunk 404'd, and the sweep produced a full matrix
    // of unstyled HTML that looked, at a glance in a thumbnail, like a page. A
    // reviewer should never have to wonder whether they are looking at the
    // design or at its absence.
    let rules = 0
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        rules += sheet.cssRules.length
      } catch {
        // Cross-origin sheet. There are none here, but do not throw over it.
      }
    }
    return {
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      cssRules: rules,
    }
  })

  await context.close()

  return {
    shot: base,
    status: response?.status() ?? 0,
    horizontalOverflow: measured.scrollWidth > measured.clientWidth + 1,
    overflowBy: measured.scrollWidth - measured.clientWidth,
    unstyled: measured.cssRules === 0,
    consoleErrors: problems,
  }
}

const sweep = async (browser, { dir, viewports, routeList, fixture, tag }) => {
  const results = []
  for (const route of routeList) {
    for (const viewport of viewports) {
      for (const theme of THEMES) {
        const result = await shoot(browser, {
          route,
          viewport,
          theme,
          dir,
          tag,
        })
        results.push({ route: route.path, fixture: fixture ?? 'live', ...result })
        const flags = [
          result.status >= 400 ? `HTTP ${result.status}` : null,
          result.unstyled ? 'NO STYLESHEET' : null,
          result.horizontalOverflow ? `OVERFLOW +${result.overflowBy}px` : null,
          result.consoleErrors.length
            ? `${result.consoleErrors.length} console error(s)`
            : null,
        ].filter(Boolean)
        log(`${result.shot}${flags.length ? `   ⚠ ${flags.join(' · ')}` : ''}`)
      }
    }
  }
  return results
}

const main = async () => {
  await rm(OUT, { recursive: true, force: true })
  await mkdir(OUT, { recursive: true })

  await requireFreePort()

  const browser = await chromium.launch()
  const results = []

  try {
    if (!REUSE) {
      log('building (live catalog)…')
      await build(null)
    }
    log(`serving ${ORIGIN}`)
    let server = await startServer(null)
    try {
      results.push(
        ...(await sweep(browser, {
          dir: OUT,
          viewports: VIEWPORTS,
          routeList: routes,
          fixture: null,
        }))
      )
    } finally {
      stopServer(server)
    }

    if (WITH_STATES) {
      const stateViewports = VIEWPORTS.filter((v) =>
        STATE_VIEWPORTS.includes(v.name)
      )
      const directory = ROUTES.filter((r) => r.name === 'networks')
      for (const state of STATES) {
        log(`building (directory state: ${state})…`)
        await build(state)
        server = await startServer(state)
        try {
          results.push(
            ...(await sweep(browser, {
              dir: OUT,
              viewports: stateViewports,
              routeList: directory,
              fixture: state,
              tag: state,
            }))
          )
        } finally {
          stopServer(server)
        }
      }
    }
  } finally {
    await browser.close()
  }

  const failures = results.filter(
    (r) =>
      r.status >= 400 ||
      r.unstyled ||
      r.horizontalOverflow ||
      r.consoleErrors.length
  )

  log(`\n${results.length} shots → ${OUT}`)
  if (failures.length === 0) {
    log('clean: styled, no HTTP errors, no sideways scroll, no console errors')
    return
  }

  log(`${failures.length} cell(s) need attention:`)
  for (const failure of failures) {
    log(`  ${failure.shot}`)
    if (failure.status >= 400) log(`    HTTP ${failure.status}`)
    if (failure.unstyled)
      log('    NO STYLESHEET — every rule is missing, this shot is not a design')
    if (failure.horizontalOverflow)
      log(`    scrolls sideways by ${failure.overflowBy}px`)
    for (const error of failure.consoleErrors.slice(0, 6))
      log(`    console: ${error.slice(0, 200)}`)
  }
  process.exitCode = 1
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
