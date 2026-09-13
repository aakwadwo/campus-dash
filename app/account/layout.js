import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/auth/session';
import { vendorOnlyHome } from '@/lib/auth/landing';
import SiteHeader from '../site-header';
import SiteFooter from '../site-footer';
import { Container } from '../ui';
import AccountNav from './account-nav';

/**
 * The account area.
 *
 * A VENDOR-ONLY ACCOUNT NEVER SEES THIS. Somebody who runs a store off campus
 * and has never ordered anything has no order history, no Partner application
 * and no reason to be told Campus Dash has capabilities: their whole product is
 * the order board. They are sent there.
 *
 * That is a routing decision, not a security one — nothing behind this layout
 * would return them anything anyway, because every read underneath filters by
 * auth.uid().
 */
export default async function AccountLayout({ children }) {
  const me = await requireUser();

  // The same rule the homepage and the marketplace apply, from one place.
  const vendorHome = vendorOnlyHome(me);
  if (vendorHome) redirect(vendorHome);

  return (
    <div className="min-h-dvh">
      <SiteHeader active="account" />

      <main className="pb-24 sm:pb-0">
        <Container className="pt-6 sm:pt-10">
          <div className="grid gap-6 lg:grid-cols-[200px_minmax(0,1fr)] lg:gap-10">
            <AccountNav items={navFor(me)} />
            <div className="min-w-0">{children}</div>
          </div>
        </Container>
      </main>

      <SiteFooter />
    </div>
  );
}

/**
 * Where this account can go, in the order it makes sense to a person.
 *
 * Customer first, because the overwhelming reason anybody opens this area is to
 * look at an order. Settings is deliberately NOT first and deliberately not the
 * default: an account screen that opens on a form for changing your surname is
 * answering a question almost nobody asked.
 *
 * "Become a Vendor" is a separate entry rather than a mode, because running a
 * store is not a thing you toggle into between lunches — it is an application,
 * reviewed by a person, and it belongs beside the other places you can go
 * rather than inside a switcher that implies you already have one.
 */
function navFor(me) {
  const items = [{ href: '/account', label: 'Overview', exact: true }];

  if (me.is_partner) {
    items.push({ href: '/partner', label: 'Partner deliveries' });
  } else if (me.partner_status === 'PENDING_REVIEW') {
    items.push({ href: '/partner', label: 'Partner application', note: 'Pending', tone: 'warn' });
  } else {
    items.push({ href: '/partner', label: 'Become a Partner' });
  }

  items.push({ href: '/account/settings', label: 'Settings' });

  if (me.vendor_ids?.length) {
    items.push({ href: '/vendor', label: 'Store dashboard' });
  } else if (me.vendor_status && me.vendor_status !== 'NOT_APPLIED') {
    items.push({
      href: '/vendor/application',
      label: 'Store application',
      note: 'Pending',
      tone: 'warn',
    });
  } else {
    items.push({ href: '/vendor/signup', label: 'Become a Vendor' });
  }

  return items;
}
