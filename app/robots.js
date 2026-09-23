import { config } from '@/lib/config';

/**
 * robots.txt.
 *
 * ONE OF TWO LAYERS, and the weaker one. A crawler may ignore this file, and it
 * cannot un-index a page already discovered through a link — so every private
 * route also sets `robots: { index: false }` in its own metadata, which is
 * honoured by the crawler that actually fetched the page. This exists to stop
 * the fetch happening at all, and to keep authenticated URLs out of crawl
 * budget and out of logs.
 *
 * WHAT IS DISALLOWED IS EVERY ROUTE THAT NEEDS A SESSION. Not because any of it
 * would work for a crawler — it would all bounce to a sign-in — but because a
 * URL like /orders/<uuid> appearing anywhere is a leak of the shape of somebody
 * else's data, and /admin should not be advertised at all.
 *
 * `/api/` covers the webhooks and the status endpoints. `/dev/` is the fake SMS
 * inbox, which only exists outside production and should never be crawled even
 * there.
 */
export default function robots() {
  const origin = config.canonicalOrigin();

  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: [
          '/admin',
          '/account',
          '/orders',
          '/partner',
          '/vendor',
          '/login',
          '/signup',
          '/terms/accept',
          '/payment',
          '/suspended',
          '/api/',
          '/dev/',
        ],
      },
    ],
    sitemap: `${origin}/sitemap.xml`,
    host: origin,
  };
}
