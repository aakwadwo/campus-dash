import { CONTACT_NUMBERS } from '@/lib/contact';

/**
 * "Need help? Call 053 127 5217 or 059 466 7183."
 *
 * ONE LINE, QUIET, AND THE SAME EVERYWHERE: the landing page, the marketplace,
 * the checkout and the footer. It is there to be found by somebody who is
 * looking for it, never to compete with what the page is for, so it is small
 * muted text rather than a button or a banner. Each number is a tel: link with
 * a 44px target, because the person reading it is usually holding a phone.
 */
export default function ContactLine({ lead = 'Need help?', className = '' }) {
  const [first, second] = CONTACT_NUMBERS;
  return (
    <p className={`text-muted text-sm ${className}`}>
      {lead ? `${lead} ` : null}Call <ContactNumber number={first} /> or{' '}
      <ContactNumber number={second} />
    </p>
  );
}

function ContactNumber({ number }) {
  return (
    <a
      href={`tel:${number.tel}`}
      className="text-ink decoration-line-strong hover:decoration-ink inline-flex min-h-11 items-center font-medium whitespace-nowrap underline underline-offset-4 transition-colors"
    >
      {number.display}
    </a>
  );
}
