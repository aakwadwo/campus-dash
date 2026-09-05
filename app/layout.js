import './globals.css';

export const metadata = {
  title: 'Campus Dash',
  description:
    'Get what you need from trusted vendors around Academic City. Pick it up, or let a verified student Partner bring it.',
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
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#fbfbfa' },
    { media: '(prefers-color-scheme: dark)', color: '#0d0d0c' },
  ],
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body className="min-h-dvh antialiased">{children}</body>
    </html>
  );
}
