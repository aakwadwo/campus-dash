import { TEXT_LINK_CLASS } from '@/app/ui';

/**
 * The customer's scan, for the Partner to show at the counter.
 *
 * IT IS A DISPLAY, AND THAT IS THE CHANGE. This screen used to ask the Partner
 * what the counter had done with the scan and record their answer as the
 * redemption — a claim about somebody else's system, made by the one person
 * standing there who could not verify it. The STORE says whether an entitlement
 * is honoured now, on its own board, and the Partner collects the food the same
 * way they collect any other order: the store reads out four digits and the
 * Partner types them in.
 *
 * So there are no buttons here. What the Partner needs is the image and the
 * instruction not to pay, and both are above the code box that follows.
 *
 * The URL is minted per request and expires on its own, so this component never
 * holds a durable link to somebody's meal entitlement.
 */
export default function ScanCollection({ scanUrl, restaurantName }) {
  return (
    <section className="rounded-card bg-surface ring-line p-4 ring-1">
      <h2 className="text-muted text-sm font-medium">The customer’s scan</h2>
      <p className="text-muted mt-1 text-sm leading-relaxed">
        Show this at {restaurantName}. They check it and hand the food over, then read you a 4-digit
        code. The food is already paid for, so do not pay for it yourself.
      </p>

      {scanUrl ? (
        scanUrl.includes('.pdf') ? (
          <a
            href={scanUrl}
            target="_blank"
            rel="noreferrer"
            className={`${TEXT_LINK_CLASS} mt-3 inline-flex min-h-11 items-center text-sm`}
          >
            Open the scan (PDF)
          </a>
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={scanUrl}
            alt="The customer’s meal scan"
            className="ring-line mt-3 w-full rounded ring-1"
          />
        )
      ) : (
        <p className="bg-warn-bg text-warn mt-3 rounded px-3 py-2 text-sm">
          The scan could not be loaded. Reload the page; if it still will not show, do not pay for
          the food and contact Campus Dash.
        </p>
      )}
    </section>
  );
}
