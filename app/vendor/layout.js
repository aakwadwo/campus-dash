import { requireVendorStaff } from '@/lib/auth/session';

export const metadata = { title: 'Vendor · Campus Dash' };

/**
 * requireVendorStaff() runs on every vendor page through this layout. It is a
 * convenience, not the boundary: the board and every action re-check
 * is_vendor_staff() in the database, so bypassing this reaches screens that
 * return nothing.
 */
export default async function VendorLayout({ children }) {
  await requireVendorStaff();
  return <div className="bg-canvas min-h-dvh">{children}</div>;
}
