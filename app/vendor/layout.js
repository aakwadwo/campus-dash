import { requireUser } from '@/lib/auth/session';

export const metadata = { title: 'Vendor · Campus Dash' };

/**
 * Guards the SESSION here, and membership one level down.
 *
 * This layout used to call requireVendorStaff(), which bounced anyone with no
 * stall straight to landingFor() — for an administrator, /admin. That read as
 * "/vendor shows the admin dashboard" and cost an afternoon of looking for a
 * routing bug that did not exist.
 *
 * Membership is checked where it can be explained: the index lists the stalls
 * you staff and says so when there are none, and every child route re-checks in
 * the database. /vendor/<someone else's id> still 404s, because getMyVendors()
 * and vendor_order_detail() both re-derive is_vendor_staff() server-side. This
 * layout was never the boundary — RLS and the SECURITY DEFINER functions are.
 */
export default async function VendorLayout({ children }) {
  await requireUser('/vendor');
  return <div className="bg-canvas min-h-dvh">{children}</div>;
}
