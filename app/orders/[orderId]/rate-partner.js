'use client';

import { useState, useTransition } from 'react';
import { ratePartnerAction } from '@/app/order/actions';

/**
 * The rating prompt.
 *
 * FIVE TAPS AND A CLOSE BUTTON. It appears once, on the order the customer just
 * received, and it does not come back — dismissing it is a real choice, and a
 * prompt that reappears until it gets an answer is not a prompt, it is a toll.
 *
 * The comment box is revealed by picking a star rather than shown alongside
 * them. Somebody who wants to say something will; somebody who does not should
 * see one row of stars and a way out.
 *
 * NOTHING HERE DECIDES WHO IS RATED. The action sends an order id, and
 * customer_rate_partner reads the Partner off that order — so there is nothing
 * in this component for a modified request to point somewhere else.
 */
export default function RatePartner({ orderId }) {
  const [stars, setStars] = useState(0);
  const [hover, setHover] = useState(0);
  const [comment, setComment] = useState('');
  const [done, setDone] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [error, setError] = useState(null);
  const [pending, start] = useTransition();

  if (dismissed) return null;

  if (done) {
    return (
      <div className="border-line rounded-panel bg-surface mt-4 border px-5 py-4">
        <p className="text-sm font-semibold">Thanks. That helps.</p>
      </div>
    );
  }

  function submit() {
    setError(null);
    start(async () => {
      const result = await ratePartnerAction({ orderId, stars, comment });
      if (result.ok) setDone(true);
      else setError(result.message);
    });
  }

  const shown = hover || stars;

  return (
    <section className="border-line rounded-panel bg-surface mt-4 border px-5 py-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold">How was your Partner?</h2>
          <p className="text-muted mt-0.5 text-xs">Optional, and it takes a second.</p>
        </div>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="text-faint hover:text-muted press-sm -mt-1 -mr-1 rounded-full p-2 text-xs font-semibold"
          aria-label="Dismiss"
        >
          Not now
        </button>
      </div>

      <div
        className="mt-3 flex gap-1"
        role="radiogroup"
        aria-label="Rating, one to five stars"
        onMouseLeave={() => setHover(0)}
      >
        {[1, 2, 3, 4, 5].map((value) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={stars === value}
            aria-label={`${value} ${value === 1 ? 'star' : 'stars'}`}
            disabled={pending}
            onMouseEnter={() => setHover(value)}
            onFocus={() => setHover(value)}
            onBlur={() => setHover(0)}
            onClick={() => setStars(value)}
            className="press-sm rounded-full p-1 disabled:opacity-55"
          >
            <Star filled={value <= shown} />
          </button>
        ))}
      </div>

      {stars > 0 ? (
        <div className="mt-3">
          <label className="block">
            <span className="sr-only">Anything you want to add</span>
            <textarea
              rows={2}
              maxLength={500}
              value={comment}
              onChange={(event) => setComment(event.target.value)}
              placeholder="Anything you want to add (optional)"
              className="rounded-input border-line-strong bg-surface w-full border px-3 py-2 text-sm"
            />
          </label>
          <button
            type="button"
            onClick={submit}
            disabled={pending}
            className="press bg-brand-700 hover:bg-brand-800 mt-2 h-10 w-full rounded-full text-sm font-semibold text-white transition-colors disabled:opacity-55"
          >
            {pending ? 'Sending…' : 'Submit'}
          </button>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="text-bad mt-2 text-sm">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function Star({ filled }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={`size-8 ${filled ? 'text-brand-500' : 'text-surface-3'}`}
      fill="currentColor"
      aria-hidden
    >
      <path d="m12 3.6 2.6 5.5 6 .8-4.4 4.2 1.1 6-5.3-2.9-5.3 2.9 1.1-6L3.4 9.9l6-.8L12 3.6Z" />
    </svg>
  );
}
