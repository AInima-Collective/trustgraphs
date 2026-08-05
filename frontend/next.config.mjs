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
    // Contribution work now stays on the round feed; money has one dedicated claim route.
    {
      source: '/networks/:id/contribute',
      destination: '/networks/:id',
      permanent: true,
    },
    {
      source: '/networks/:id/rate',
      destination: '/networks/:id',
      permanent: true,
    },
    {
      source: '/networks/:id/respond',
      destination: '/networks/:id',
      permanent: true,
    },
    {
      source: '/networks/:id/payout',
      destination: '/networks/:id/claim',
      permanent: true,
    },
  ],
}

export default withPlausibleProxy()(nextConfig)
