import { config } from './lib/config.js';

/**
 * Content Security Policy.
 *
 * Built here rather than written out as a string because one directive —
 * connect-src — has to name the Supabase project this deployment actually talks
 * to, and that differs between local, preview and production. Getting it wrong
 * does not fail quietly: the browser blocks every query and the app looks
 * broken for reasons nothing in the app explains.
 *
 * WHAT THIS POLICY IS FOR. The item it closes is clickjacking, and that is
 * `frame-ancestors 'none'` — a directive with no legitimate counter-example
 * here, because nothing in Campus Dash is ever meant to be embedded. The rest
 * is defence in depth, and each directive below is set to the loosest value
 * that is still honest about what the app does.
 *
 * WHAT IT DOES NOT DO. `script-src` carries 'unsafe-inline'. Next streams the
 * RSC payload through inline <script> tags, so a policy without it serves a
 * blank page. Removing it means giving every response a per-request nonce from
 * the proxy, which would opt every page out of static rendering — a larger and
 * riskier change than the finding warrants. So this policy is a real barrier to
 * framing and to loading foreign code, and it is NOT an XSS mitigation. Output
 * escaping is still what stands between us and injected script.
 */
function contentSecurityPolicy() {
  const production = config.isProduction();

  // Absent during a bare `next build` with no environment. Omitting the origin
  // is better than emitting the string "null" into a directive.
  const supabase = config.isSupabaseConfigured() ? config.supabaseUrl() : null;
  const supabaseSocket = supabase ? supabase.replace(/^http/, 'ws') : null;

  const directives = {
    'default-src': ["'self'"],
    'base-uri': ["'self'"],
    // Nothing here is embeddable, and nothing here embeds. This pair is the
    // clickjacking fix; X-Frame-Options below repeats it for older browsers.
    'frame-ancestors': ["'none'"],
    // The dev error overlay frames itself; production frames nothing at all.
    'frame-src': production ? ["'none'"] : ["'self'"],
    'object-src': ["'none'"],
    // Checkout is a top-level redirect to Paystack, never a cross-origin POST,
    // so every form on the site really does submit to us.
    'form-action': ["'self'"],
    'script-src': ["'self'", "'unsafe-inline'", ...(production ? [] : ["'unsafe-eval'"])],
    'style-src': ["'self'", "'unsafe-inline'"],
    // data: and blob: are the ID and selfie capture on /partner/apply and
    // /onboarding — createObjectURL previews before upload. Supabase serves the
    // signed document URLs an administrator reviews.
    'img-src': ["'self'", 'data:', 'blob:', supabase].filter(Boolean),
    'font-src': ["'self'", 'data:'],
    'media-src': ["'self'", 'blob:'],
    'worker-src': ["'self'", 'blob:'],
    'manifest-src': ["'self'"],
    // supabase-js talks to the project straight from the browser: PostgREST,
    // auth and storage over https, realtime over wss. ws: is the dev server's
    // own hot-reload socket and is not present in a production policy.
    'connect-src': [
      "'self'",
      supabase,
      supabaseSocket,
      ...(production ? [] : ['ws:', 'http://127.0.0.1:54321']),
    ].filter(Boolean),
  };

  if (production) directives['upgrade-insecure-requests'] = [];

  return Object.entries(directives)
    .map(([name, values]) => (values.length ? `${name} ${values.join(' ')}` : name))
    .join('; ');
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The local Supabase stack reaches the app on 127.0.0.1 (and from inside
  // Docker via host.docker.internal), so the dev server must accept those
  // origins for its own assets. Development only; ignored in production.
  allowedDevOrigins: ['127.0.0.1', 'localhost', 'host.docker.internal'],
  async headers() {
    const securityHeaders = [
      { key: 'Content-Security-Policy', value: contentSecurityPolicy() },
      // Says the same thing as frame-ancestors to browsers that predate it.
      // Both are sent deliberately; a browser that understands CSP ignores this.
      { key: 'X-Frame-Options', value: 'DENY' },
      // Partner ID/selfie capture requires the device camera. Next does not set
      // Permissions-Policy by default; we allow camera on same-origin only.
      { key: 'Permissions-Policy', value: 'camera=(self), microphone=(), geolocation=()' },
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    ];

    // Only over TLS, and without preload: this deployment is HTTPS everywhere,
    // but preload is a one-way door and not ours to walk through for a pilot.
    if (config.isProduction()) {
      securityHeaders.push({
        key: 'Strict-Transport-Security',
        value: 'max-age=31536000',
      });
    }

    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
