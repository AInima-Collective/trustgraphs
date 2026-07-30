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
  ],
}

export default withPlausibleProxy()(nextConfig)
