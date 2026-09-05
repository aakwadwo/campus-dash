import { ButtonLink } from './ui';

export const metadata = { title: 'Not found · Campus Dash' };

/**
 * A 404 that offers the marketplace rather than an apology.
 *
 * Most 404s here are a stale order link or a vendor that has since been
 * removed, so the useful next step is almost always "go and look at what is
 * open" — not a support address.
 */
export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center px-6 text-center">
      <h1 className="text-display text-2xl font-semibold sm:text-3xl">We could not find that</h1>
      <p className="text-muted mt-3 leading-relaxed">
        The page may have moved, or the vendor may no longer be on Campus Dash.
      </p>
      <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
        <ButtonLink href="/order">Browse vendors</ButtonLink>
        <ButtonLink href="/" variant="secondary">
          Home
        </ButtonLink>
      </div>
    </main>
  );
}
