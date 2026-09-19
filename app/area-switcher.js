import { myAreas } from '@/lib/auth/session';
import MenuDisclosure from './menu-disclosure';

/**
 * Every OTHER area this account may enter, behind one "Switch to" control.
 *
 * WHY THIS EXISTS. landingFor() sends a multi-capability account to exactly one
 * place — an administrator to /admin, a store owner to /vendor — and without a
 * way across, an admin who also ordered lunch concluded the account had
 * "become" an admin account.
 *
 * WHAT IT USED TO SAY: "Also yours: Order · Partner". "Yours" told nobody where
 * a link went, and the whole control was hidden below `sm`, so on the phone
 * most of these accounts actually use there was no way across at all. It is
 * now one menu, the same at every width, and each entry is named for what is
 * there rather than for the capability behind it.
 *
 * The list is derived from my_capabilities(), so it can only ever offer an area
 * the destination would let them into. It renders nothing when there is no
 * other area, because a switcher with one option is noise.
 */
const AREA_COPY = {
  '/order': { label: 'Order food', description: 'Browse stores and track your orders' },
  '/vendor': { label: 'Store dashboard', description: 'Orders, sales and your menu' },
  '/partner': { label: 'Partner deliveries', description: 'Available orders and earnings' },
  '/admin': { label: 'Admin console', description: 'Operations, approvals and settings' },
};

/**
 * WHERE YOU ARE, named on the button in the customer area, whose header has no
 * area name of its own; elsewhere the header already says it, and the button
 * simply says "Switch". Either way it opens to the other areas.
 */
const CURRENT_NAME = {
  // Only where the header does not already say it. The store, Partner and
  // admin headers carry their own name beside the logo, so there the button
  // says what it does instead of repeating it.
  '/order': 'Customer',
};

export default async function AreaSwitcher({ current }) {
  const areas = await myAreas();
  const others = areas
    .filter((area) => area.href !== current && area.href !== '/account')
    .map((area) => ({ href: area.href, ...(AREA_COPY[area.href] ?? { label: area.label }) }));
  if (others.length === 0) return null;

  const here = CURRENT_NAME[current] ?? 'Switch';
  return (
    <MenuDisclosure
      label={here}
      ariaLabel={`You are in ${here}. Switch to another area of your account`}
      items={others}
    />
  );
}
