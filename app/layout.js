import './globals.css';

export const metadata = {
  title: {
    default: 'Campus Dash',
    template: '%s · Campus Dash',
  },
  description:
    'Order from stores around Academic City. Collect it yourself, or have a Campus Dash Partner bring it to you.',
  applicationName: 'Campus Dash',
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
      <body className="min-h-dvh antialiased">{children}</body>
    </html>
  );
}
