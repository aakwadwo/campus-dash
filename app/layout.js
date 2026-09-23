import { Suspense } from 'react';
import { config } from '@/lib/config';
import './globals.css';
import NavigationProgress from './navigation-progress';

const DESCRIPTION =
  'Order from stores around Academic City. Collect it yourself, or have a Campus Dash Partner bring it to you.';

export const metadata = {
  /**
   * EVERY RELATIVE URL BELOW RESOLVES AGAINST THIS, including the canonical and
   * Open Graph ones each page sets. Without it Next emits relative canonicals,
   * which are not valid in a <link rel="canonical"> and which social scrapers
   * simply drop.
   *
   * config.canonicalOrigin() refuses to return a *.vercel.app host, so a
   * preview deployment can never declare itself canonical — which is how a
   * staging URL ends up in search results competing with the real site.
   */
  metadataBase: new URL(config.canonicalOrigin()),
  title: {
    // Used by any page that sets no title of its own. app/page.js sets the same
    // string explicitly, because the template below does not reach the root
    // segment and the two must not be able to drift apart.
    default: 'Campus Dash',
    template: '%s · Campus Dash',
  },
  description: DESCRIPTION,
  applicationName: 'Campus Dash',
  // NO CANONICAL HERE. Metadata is inherited, so a canonical on the root layout
  // would tell a crawler every page without its own was a copy of the home
  // page. Each public page names its own; private pages are noindex instead.
  openGraph: {
    type: 'website',
    siteName: 'Campus Dash',
    locale: 'en_GH',
    title: 'Campus Dash',
    description: DESCRIPTION,
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Campus Dash',
    description: DESCRIPTION,
  },
  /**
   * THE DEFAULT IS "DO NOT INDEX ANYTHING PRIVATE", and it is expressed the
   * other way round: this allows indexing, and every authenticated route sets
   * its own `robots: { index: false }`. robots.js refuses the whole tree of
   * them a second time.
   *
   * Two layers because they fail differently. robots.txt is a request a crawler
   * may ignore and cannot stop a page already discovered through a link; a
   * noindex on the page itself is honoured by the crawler that actually fetched
   * it. Neither alone is enough for a page showing somebody's order.
   */
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true, 'max-image-preview': 'large' },
  },
  // Generated from info/logo2.PNG — see app/brand.js. The square variation is
  // deliberate: a wide transparent runner in a 16px tab is a smudge on whatever
  // colour the browser paints behind it.
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: '16x16 32x32 48x48' },
      { url: '/brand/icon-32.png', type: 'image/png', sizes: '32x32' },
      { url: '/brand/icon-512.png', type: 'image/png', sizes: '512x512' },
    ],
    apple: [{ url: '/brand/icon-180.png', sizes: '180x180' }],
  },
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  // Pinch-zoom stays available. The old `maximumScale: 1` was there to kill the
  // double-tap zoom that made ACCEPT/REJECT hard to hit, but blocking zoom
  // outright fails WCAG 1.4.4 and hurts exactly the people who need it most.
  // `touch-action: manipulation` on the body buys the same responsiveness
  // without taking anything away.
  maximumScale: 5,
  userScalable: true,
  // One ground, one theme colour. Campus Dash is a light product.
  themeColor: '#fafafa',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body className="min-h-dvh antialiased">
        {/* useSearchParams() needs a Suspense boundary of its own, or it would
            opt every page into client rendering. */}
        <Suspense fallback={null}>
          <NavigationProgress />
        </Suspense>
        {children}
      </body>
    </html>
  );
}
