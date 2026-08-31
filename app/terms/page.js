import Link from 'next/link';
import { requireUser } from '@/lib/auth/session';
import { outstandingTerms, currentTerms } from '@/lib/terms';
import AcceptForm from './accept-form';

export const metadata = { title: 'Terms · Campus Dash' };
export const dynamic = 'force-dynamic';

const AUDIENCE_LABEL = {
  CUSTOMER: 'Ordering with Campus Dash',
  VENDOR: 'Selling on Campus Dash',
  PARTNER: 'Delivering with Campus Dash',
};

export default async function TermsPage() {
  await requireUser('/terms');

  const outstanding = await outstandingTerms();
  const documents = await Promise.all(
    (outstanding ?? []).map(async (item) => ({
      ...item,
      document: await currentTerms(item.audience),
    }))
  );

  return (
    <main className="mx-auto max-w-md px-4 pt-6 pb-16">
      <h1 className="text-2xl font-semibold tracking-tight">Terms</h1>

      {documents.length === 0 ? (
        <>
          <p className="text-muted mt-2 text-sm">
            You have accepted the current terms for everything you use.
          </p>
          <Link
            href="/account"
            className="mt-6 block rounded-lg bg-white py-3 text-center text-sm font-semibold ring-1 ring-black/15"
          >
            Back to your account
          </Link>
        </>
      ) : (
        <>
          <p className="text-muted mt-2 text-sm">
            Please read and accept. We record which version you agreed to, and when.
          </p>
          <div className="mt-6 space-y-6">
            {documents.map((item) => (
              <section key={item.audience} className="rounded-lg bg-white p-4 ring-1 ring-black/5">
                <p className="text-muted text-xs font-medium tracking-wide uppercase">
                  {AUDIENCE_LABEL[item.audience] ?? item.audience}
                </p>
                <h2 className="mt-1 font-semibold">{item.document?.title ?? item.title}</h2>
                <p className="text-muted text-xs">Version {item.version}</p>
                <div className="mt-3 max-h-64 overflow-y-auto rounded bg-black/[0.03] p-3 text-sm whitespace-pre-line">
                  {item.document?.body ?? ''}
                </div>
                {item.document ? <AcceptForm termsId={item.document.terms_id} /> : null}
              </section>
            ))}
          </div>
        </>
      )}
    </main>
  );
}
