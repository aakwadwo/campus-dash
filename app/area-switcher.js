import Link from 'next/link';
import { myAreas } from '@/lib/auth/session';

/**
 * Every area this account may enter.
 *
 * WHY THIS EXISTS. landingFor() sends a multi-capability account to exactly one
 * place — an administrator to /admin, vendor staff to /vendor — and until now
 * there was no way back. An admin who also ordered lunch reasonably concluded
 * the account had "become" an admin account and lost the others, which is the
 * single biggest reason the capability model read as mutually exclusive when it
 * never was.
 *
 * The list is derived from my_capabilities(), so it can only ever offer an area
 * the destination would let them into. It shows nothing when the account holds
 * one capability, because a switcher with one option is noise.
 */
export default async function AreaSwitcher({ current }) {
  const areas = await myAreas();
  const others = areas.filter((area) => area.href !== current && area.href !== '/account');
  if (others.length === 0) return null;

  return (
    <nav aria-label="Your other areas" className="flex items-center gap-3 text-sm">
      <span className="text-muted hidden sm:inline">Also yours:</span>
      {others.map((area) => (
        <Link
          key={area.href}
          href={area.href}
          className="text-brand-700 font-medium underline underline-offset-4"
        >
          {area.label}
        </Link>
      ))}
    </nav>
  );
}
