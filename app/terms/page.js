import { getCapabilities } from '@/lib/auth/session';
import { outstandingTerms, currentTerms } from '@/lib/terms';
import SiteHeader from '@/app/site-header';
import SiteFooter from '@/app/site-footer';
import { Container, Card, Callout } from '@/app/ui';
import AcceptForm from './accept-form';

export const metadata = {
  title: 'Terms',
  description:
    'The terms for ordering with Campus Dash, selling on Campus Dash, and carrying orders as a Campus Dash Partner.',
  alternates: { canonical: '/terms' },
};
export const dynamic = 'force-dynamic';

const AUDIENCE_LABEL = {
  CUSTOMER: 'Ordering with Campus Dash',
  VENDOR: 'Selling on Campus Dash',
  PARTNER: 'Carrying orders as a Campus Dash Partner',
};

const AUDIENCES = ['CUSTOMER', 'PARTNER', 'VENDOR'];

/**
 * The terms. PUBLIC, and that was a bug rather than a decision.
 *
 * This page called requireUser(), so anybody signed out who tapped "Terms" in
 * the footer — or the link under the Partner application's consent checkbox,
 * which is exactly the moment somebody wants to read them — was bounced to a
 * sign-in screen. Terms you have to authenticate to read are terms nobody reads
 * before agreeing, which defeats the point of having them, and `current_terms`
 * was already anon-callable and `terms_documents` already had an anon SELECT
 * policy for published versions. The wall was in this file alone.
 *
 * ACCEPTING is still a signed-in act, because an acceptance is a row against an
 * identity. So the page splits: everybody reads, and somebody with something
 * outstanding also gets the button.
 */
export default async function TermsPage() {
  const me = await getCapabilities();

  // Published documents, for everybody. Three audiences, always all three: a
  // student deciding whether to become a Partner should be able to read the
  // Partner terms without applying first.
  const documents = (
    await Promise.all(
      AUDIENCES.map(async (audience) => ({
        audience,
        document: await currentTerms(audience).catch(() => null),
      }))
    )
  ).filter((item) => item.document);

  // What THIS account still has to agree to, if anyone is signed in.
  const outstanding = me.authenticated ? ((await outstandingTerms().catch(() => [])) ?? []) : [];
  const outstandingBy = new Map(outstanding.map((item) => [item.audience, item]));

  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader />

      <main className="flex-1 pb-24 sm:pb-16">
        <Container size="narrow" className="pt-8 sm:pt-12">
          <h1 className="text-display text-3xl font-semibold sm:text-4xl">Terms</h1>
          <p className="text-muted mt-2 leading-relaxed">
            What you agree to when you order, sell or carry orders on Campus Dash. We record which
            version you agreed to, and when.
          </p>

          {outstanding.length > 0 ? (
            <Callout className="mt-6">
              There {outstanding.length === 1 ? 'is one document' : `are ${outstanding.length}`} you
              have not accepted yet. You can read {outstanding.length === 1 ? 'it' : 'them'} below
              and accept at the bottom of {outstanding.length === 1 ? 'the' : 'each'} section.
            </Callout>
          ) : null}

          {documents.length === 0 ? (
            <Callout tone="warn" className="mt-6">
              The terms are not published yet. Ask Campus Dash if you need a copy.
            </Callout>
          ) : (
            <div className="mt-8 space-y-6">
              {documents.map(({ audience, document }) => (
                <Card key={audience} className="p-5 sm:p-6">
                  <h2 className="text-muted text-xs font-semibold tracking-[0.14em] uppercase">
                    {AUDIENCE_LABEL[audience] ?? audience}
                  </h2>
                  <p className="mt-1.5 font-semibold">
                    {document.title}
                    <span className="text-faint ml-2 text-sm font-normal tabular-nums">
                      v{document.version}
                    </span>
                  </p>

                  <div className="text-muted mt-4 text-sm leading-relaxed whitespace-pre-line">
                    {document.body}
                  </div>

                  {/* ACCEPTING NEEDS AN IDENTITY, so the button appears only for
                      somebody signed in who has this one outstanding. Everyone
                      else has already read what they came for. */}
                  {outstandingBy.has(audience) ? (
                    <div className="border-line mt-5 border-t pt-5">
                      <AcceptForm termsId={document.terms_id} audience={audience} />
                    </div>
                  ) : null}
                </Card>
              ))}
            </div>
          )}
        </Container>
      </main>

      <SiteFooter />
    </div>
  );
}
