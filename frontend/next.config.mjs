import { withPlausibleProxy } from 'next-plausible'

/** @type {import('next').NextConfig} */
const nextConfig = {
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
      source: '/support',
      destination: 'https://t.me/%2BvzEeMpBDzWUwMThh',
      permanent: false,
    },
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
  ]
}

export default withPlausibleProxy()(nextConfig)
