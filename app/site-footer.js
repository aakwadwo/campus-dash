import Link from 'next/link';

/**
 * The consumer footer.
 *
 * BUILT FOR A THUMB. The previous version packed three small links into a
 * column at 14px, which is a target roughly 20px tall: fine with a mouse,
 * awkward with a thumb, and the thing that made the bottom of every page feel
 * like a desktop site. Every link here is now a full-width row with a 48px
 * minimum height and a divider between, so there is nothing to aim at.
 *
 * Six links total. A campus marketplace with one university does not need a
 * sitemap, and a long explanatory paragraph at the bottom of a phone screen is
 * text nobody has ever read.
 *
 * WHAT IS NOT LINKED. There is no Privacy Policy route yet, and inventing one
 * to round out the Legal section would put fabricated legal text in front of
 * students. `terms_documents` currently holds CUSTOMER, PARTNER and VENDOR
 * documents (all still marked PLACEHOLDER). A privacy policy is a real launch
 * requirement, tracked as one, not papered over with a dead link. When
 * /privacy exists it slots in below Terms.
 */

const LINKS = [
  { group: 'Campus Dash', items: [['Browse food', '/order']] },
  {
    group: 'Work with us',
    items: [
      ['Become a Partner', '/partner/apply'],
      ['Vendor sign-in', '/vendor'],
    ],
  },
  { group: 'Legal', items: [['Terms', '/terms']] },
];

export default function SiteFooter() {
  return (
    <footer className="border-line mt-14 border-t">
      <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-10">
        {/* Mobile: stacked sections of tall rows. Desktop: three columns of the
            same content, where a compact link list is the right density. */}
        <div className="grid gap-8 sm:grid-cols-3 sm:gap-10">
          {LINKS.map((section) => (
            <nav key={section.group} aria-label={section.group}>
              <h2 className="text-faint text-xs font-semibold tracking-[0.14em] uppercase">
                {section.group}
              </h2>
              <ul className="divide-line mt-1 divide-y sm:mt-3 sm:divide-y-0">
                {section.items.map(([label, href]) => (
                  <li key={href}>
                    <Link
                      href={href}
                      className="text-muted hover:text-ink press-sm flex min-h-12 items-center text-[15px] transition-colors sm:min-h-0 sm:py-1 sm:text-sm"
                    >
                      {label}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>

        <p className="text-faint border-line mt-8 border-t pt-6 text-xs">
          Campus Dash, Academic City University &middot; &copy; {new Date().getFullYear()}
        </p>
      </div>
    </footer>
  );
}
