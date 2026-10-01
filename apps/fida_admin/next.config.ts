import type { NextConfig } from 'next';

const coreApiInternalUrl = process.env.CORE_API_INTERNAL_URL ?? 'http://127.0.0.1:3000';

const nextConfig: NextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  poweredByHeader: false,
  async rewrites() {
    return [
      {
        source: '/admin/:path*',
        destination: `${coreApiInternalUrl}/api/v1/admin/:path*`,
      },
      {
        source: '/core/:path*',
        destination: `${coreApiInternalUrl}/api/v1/:path*`,
      },
    ];
  },
};

export default nextConfig;
