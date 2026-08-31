/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Partner ID/selfie capture requires the device camera. Next does not set
  // Permissions-Policy by default; we allow camera on same-origin only.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Permissions-Policy', value: 'camera=(self), microphone=(), geolocation=()' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },
};

export default nextConfig;
