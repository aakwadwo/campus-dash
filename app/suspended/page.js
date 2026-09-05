import { ButtonLink } from '@/app/ui';

export const metadata = { title: 'Account suspended · Campus Dash' };

/**
 * A dead end, made as un-hostile as possible.
 *
 * Suspension removes every capability at once, so there is genuinely nothing
 * for this person to do in the app — but a bare sentence on a white page reads
 * like a punishment. The route to a human is the only action, and it is the
 * only thing on the screen.
 */
export default function SuspendedPage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col items-center justify-center px-6 text-center">
      <h1 className="text-display text-2xl font-semibold sm:text-3xl">Account suspended</h1>
      <p className="text-muted mt-3 leading-relaxed">
        This account cannot place or deliver orders right now. If you think that is a mistake,
        Campus Dash support can look into it.
      </p>
      <ButtonLink href="/" variant="secondary" className="mt-8">
        Back to Campus Dash
      </ButtonLink>
    </main>
  );
}
