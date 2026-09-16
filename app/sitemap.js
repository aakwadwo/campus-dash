import { config } from '@/lib/config';
import { listVendors } from '@/lib/customer';

export const dynamic = 'force-dynamic';

/**
 * The sitemap.
 *
 * FOUR STATIC PAGES AND THE OPEN STORES. Nothing else in Campus Dash is public:
 * an order, an account, a dashboard and a checkout all need a session, and a
 * sitemap listing them would be advertising URLs that bounce.
 *
 * STORE PAGES ARE IN IT because they are the only public pages with content
 * worth finding — somebody searching for a restaurant by name should be able to
 * land on its menu. They are generated from the same anon-readable query the
 * marketplace uses, so a store that is not ACTIVE is absent here for the same
 * reason it is absent there, in one place rather than two.
 *
 * IT NEVER THROWS. A sitemap is a nice-to-have; the marketplace query failing
 * must not turn into a 500 on a route Google is fetching. The static entries
 * are always returned.
 */
export default async function sitemap() {
  const origin = config.canonicalOrigin();
  const now = new Date();

  const staticPages = [
    { url: `${origin}/`, lastModified: now, changeFrequency: 'daily', priority: 1 },
    { url: `${origin}/order`, lastModified: now, changeFrequency: 'daily', priority: 0.9 },
    { url: `${origin}/about`, lastModified: now, changeFrequency: 'monthly', priority: 0.5 },
    { url: `${origin}/terms`, lastModified: now, changeFrequency: 'yearly', priority: 0.3 },
  ];

  const vendors = await listVendors().catch(() => []);

  return [
    ...staticPages,
    ...(vendors ?? []).map((vendor) => ({
      url: `${origin}/order/${vendor.vendor_id}`,
      lastModified: now,
      changeFrequency: 'weekly',
      priority: 0.7,
    })),
  ];
}
