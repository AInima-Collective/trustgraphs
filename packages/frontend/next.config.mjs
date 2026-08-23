import { withPlausibleProxy } from 'next-plausible'

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Lets a second server (a dev server next to a running `next start`, say) build into its own
  // directory instead of trampling the first one's `.next`. Inert unless the env var is set.
  distDir: process.env.NEXT_DIST_DIR || '.next',
  eslint: {
    ignoreDuringBuilds: true,
  },
  typescript: {
    ignoreBuildErrors: true,
    // Screenshot builds use a disposable config because Next writes the
    // label-scoped dist types into it. Normal builds keep the project config.
    tsconfigPath: process.env.NEXT_TSCONFIG_PATH || 'tsconfig.json',
  },
  images: {
    unoptimized: true,
  },
  // /docs renders the repo's own `docs/**.md` at request time, and that tree
  // sits two directories above the frontend. Deployments that trace files into
  // a bundle (standalone output, serverless) drop anything fs-read outside
  // the app dir unless it is named here.
  outputFileTracingIncludes: {
    '/docs/[...slug]': ['../../docs/**/*.md'],
    '/docs': ['../../docs/**/*.md'],
  },
  devIndicators: false,
  webpack: (config) => {
    // Suppress all expression-based dependency warnings
    // - @whatwg-node/fetch causes "Critical dependency: the request of a dependency is an expression" when generating components server-side
    config.module.exprContextCritical = false
    return config
  },
  redirects: () => [
    {
      source: '/attestation',
      destination: '/attestations',
      permanent: false,
    },
    {
      source: '/attestation/:uid',
      destination: '/attestations/:uid',
      permanent: false,
    },
    // The network directory and the detail pages moved to `/networks/*`; these keep old links alive.
    {
      source: '/network',
      destination: '/networks',
      permanent: true,
    },
    {
      source: '/network/:path*',
      destination: '/networks/:path*',
      permanent: true,
    },
  ],
}

export default withPlausibleProxy()(nextConfig)
