'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeftIcon } from './ui';

/**
 * "Back", to wherever the person actually came from.
 *
 * THE ONBOARDING PAGES ARE REACHED FROM SEVERAL PLACES: become a Partner from
 * the landing page, from the account screen, from the footer; register a store
 * from the landing banner or the account screen. A fixed link sent every one of
 * them to the same page, usually `/`, which is the wrong answer for most of
 * them. So when the previous page was part of Campus Dash, this goes back to
 * it; when somebody arrived from outside (a shared link, a new tab) it goes to
 * `fallback`, which each page picks as its sensible parent.
 *
 * Same shape as BackLink, so every back control in the product looks the same.
 * It is a real link to the fallback underneath, so it works with no JavaScript.
 */
export default function BackButton({ fallback = '/', label = 'Back', className = '' }) {
  const router = useRouter();

  return (
    <Link
      href={fallback}
      onClick={(event) => {
        if (cameFromHere()) {
          event.preventDefault();
          router.back();
        }
      }}
      className={`text-muted hover:text-ink hover:bg-surface-2 press-sm -ml-2 inline-flex min-h-11 w-fit items-center gap-1.5 rounded-full pr-3.5 pl-2 text-sm font-medium transition-colors ${className}`}
    >
      <ArrowLeftIcon className="size-4" />
      {label}
    </Link>
  );
}

function cameFromHere() {
  try {
    return (
      window.history.length > 1 &&
      Boolean(document.referrer) &&
      new URL(document.referrer).origin === window.location.origin
    );
  } catch {
    return false;
  }
}
