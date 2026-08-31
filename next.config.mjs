/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The local Supabase stack reaches the app on 127.0.0.1 (and from inside
  // Docker via host.docker.internal), so the dev server must accept those
  // origins for its own assets. Development only; ignored in production.
  allowedDevOrigins: ['127.0.0.1', 'localhost', 'host.docker.internal'],
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
