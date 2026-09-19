import Link from 'next/link';
import { CampusDashLogo } from './brand';
import { CONTACT_NUMBERS } from '@/lib/contact';

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
 * students. `terms_documents` holds the CUSTOMER, PARTNER and VENDOR terms,
 * all on one /terms page. A privacy policy is a real launch
 * requirement, tracked as one, not papered over with a dead link. When
 * /privacy exists it slots in below Terms.
 */

const LINKS = [
  {
    group: 'Campus Dash',
    items: [
      ['Browse food', '/order'],
      ['What we are building', '/about'],
    ],
  },
  {
    group: 'Work with us',
    items: [
      ['Become a Partner', '/partner/apply'],
      ['Sell on Campus Dash', '/vendor/signup'],
    ],
  },
  { group: 'Legal', items: [['Terms', '/terms']] },
  // tel: links, so a tap on a phone dials. The numbers live in lib/contact.js.
  {
    group: 'Contact',
    items: CONTACT_NUMBERS.map((number) => [`Call ${number.display}`, `tel:${number.tel}`]),
  },
];

/**
 * THE FOOTER SITS AT THE BOTTOM, and on a short page that is not the same thing
 * as sitting after the content.
 *
 * `mt-14` put it below whatever came before it, which on a page with one
 * paragraph left it floating in the middle of the viewport with white space
 * underneath. The fix is a layout rather than a margin: the page is a flex
 * column at least as tall as the viewport, `main` grows to fill it, and the
 * footer lands on the bottom edge when there is spare room and immediately
 * after the content when there is not. `mt-auto` here is the half of that
 * contract this component owns; see the `flex min-h-dvh flex-col` wrapper on
 * every page that renders one.
 *
 * NOT FIXED, and never. A fixed footer overlaps content on a phone and covers
 * the last thing somebody was reading.
 */
const FOOTER_LINK =
  'text-muted hover:text-ink press-sm flex min-h-12 items-center text-[15px] transition-colors sm:min-h-0 sm:py-1 sm:text-sm';

export default function SiteFooter() {
  return (
    <footer className="border-line mt-auto border-t pt-14">
      <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-10">
        {/* Mobile: stacked sections of tall rows. Desktop: four columns of the
            same content, where a compact link list is the right density. */}
        <div className="grid gap-8 sm:grid-cols-4 sm:gap-10">
          {LINKS.map((section) => (
            <nav key={section.group} aria-label={section.group}>
              <h2 className="text-faint text-xs font-semibold tracking-[0.14em] uppercase">
                {section.group}
              </h2>
              <ul className="divide-line mt-1 divide-y sm:mt-3 sm:divide-y-0">
                {section.items.map(([label, href]) => (
                  <li key={href}>
                    {/* A dial is not a navigation, so a tel: row is a plain
                        anchor rather than a client-side Link. */}
                    {href.startsWith('tel:') ? (
                      <a href={href} className={FOOTER_LINK}>
                        {label}
                      </a>
                    ) : (
                      <Link href={href} className={FOOTER_LINK}>
                        {label}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>

        <div className="border-line mt-8 flex flex-wrap items-center justify-between gap-4 border-t pt-6">
          <CampusDashLogo height={24} />
          <p className="text-faint text-xs">
            Academic City University, Accra &middot; &copy; {new Date().getFullYear()}
          </p>
        </div>
      </div>
    </footer>
  );
}
