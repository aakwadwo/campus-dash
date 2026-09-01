import './globals.css';

export const metadata = {
  title: 'Campus Dash',
  description:
    'Get what you need from trusted vendors around Academic City. Pick it up, or let a verified student Partner bring it.',
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  // Vendor and Partner screens are used one-handed on a phone; prevent the
  // accidental double-tap zoom that makes ACCEPT/REJECT hard to hit.
  maximumScale: 1,
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body className="min-h-dvh antialiased">{children}</body>
    </html>
  );
}
