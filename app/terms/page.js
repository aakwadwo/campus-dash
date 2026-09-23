import { getCapabilities } from '@/lib/auth/session';
import { outstandingTerms, currentTerms } from '@/lib/terms';
import SiteHeader from '@/app/site-header';
import SiteFooter from '@/app/site-footer';
import { Container, Callout, Disclosure } from '@/app/ui';
import ContactLine from '@/app/contact-line';
import AcceptForm from './accept-form';

export const metadata = {
  title: 'Terms',
  description:
    'The terms for ordering with Campus Dash, selling on Campus Dash, and carrying orders as a Campus Dash Partner.',
  alternates: { canonical: '/terms' },
  openGraph: {
    title: 'Terms · Campus Dash',
    description:
      'The terms for ordering with Campus Dash, selling on Campus Dash, and carrying orders as a Campus Dash Partner.',
    url: '/terms',
  },
};
export const dynamic = 'force-dynamic';

const AUDIENCE_LABEL = {
  CUSTOMER: 'Customer terms',
  VENDOR: 'Store terms',
  PARTNER: 'Partner terms',
};

// What each document is about, so somebody can open the one they need. The
// VERSION is deliberately not shown: it is recorded against every acceptance
// for audit, and means nothing to somebody reading.
const AUDIENCE_SUMMARY = {
  CUSTOMER: 'Ordering, paying, collecting and refunds',
  PARTNER: 'Carrying orders and earning',
  VENDOR: 'Running a store and getting paid',
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
export default async function TermsPage({ searchParams }) {
  const params = await searchParams;
  const asked = String(params?.audience ?? '').toUpperCase();
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
            How Campus Dash works, and what you agree to when you order, carry orders or run a store
            on it.
          </p>

          {outstanding.length > 0 ? (
            <Callout className="mt-6">
              {outstanding.length === 1
                ? 'One of these is waiting for your agreement. Accept it at the end of the section.'
                : 'Some of these are waiting for your agreement. Accept each at the end of its section.'}
            </Callout>
          ) : null}

          {documents.length === 0 ? (
            <Callout tone="warn" className="mt-6">
              The terms are not published yet. Call us if you need a copy.
            </Callout>
          ) : (
            <div className="border-line mt-8 border-t">
              {documents.map(({ audience, document }) => (
                <Disclosure
                  key={audience}
                  title={AUDIENCE_LABEL[audience] ?? document.title}
                  summary={
                    outstandingBy.has(audience)
                      ? 'Waiting for your agreement'
                      : (AUDIENCE_SUMMARY[audience] ?? null)
                  }
                  defaultOpen={asked === audience || outstandingBy.has(audience)}
                >
                  <TermsBody text={document.body} />

                  {/* ACCEPTING NEEDS AN IDENTITY, so the button appears only for
                      somebody signed in who has this one outstanding. */}
                  {outstandingBy.has(audience) ? (
                    <div className="border-line mt-6 border-t pt-5">
                      <AcceptForm termsId={document.terms_id} audience={audience} />
                    </div>
                  ) : null}
                </Disclosure>
              ))}
            </div>
          )}

          <ContactLine lead="Questions?" className="mt-8" />
        </Container>
      </main>

      <SiteFooter />
    </div>
  );
}

/**
 * The published text, which is plain on purpose: "## " starts a section, "- "
 * a list item, and a blank line a new paragraph. Rendered here as headings,
 * lists and paragraphs; readable as-is anywhere else it is shown.
 */
function TermsBody({ text }) {
  const blocks = [];
  let list = null;

  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim();
    if (line.startsWith('- ')) {
      if (!list) {
        list = [];
        blocks.push({ kind: 'list', items: list });
      }
      list.push(line.slice(2));
      continue;
    }
    list = null;
    if (!line) continue;
    if (line.startsWith('## ')) blocks.push({ kind: 'heading', text: line.slice(3) });
    else blocks.push({ kind: 'paragraph', text: line });
  }

  return (
    <div className="text-muted space-y-3 text-[15px] leading-relaxed">
      {blocks.map((block, index) =>
        block.kind === 'heading' ? (
          <h3 key={index} className="text-ink pt-3 font-semibold">
            {block.text}
          </h3>
        ) : block.kind === 'list' ? (
          <ul key={index} className="list-disc space-y-1 pl-5">
            {block.items.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        ) : (
          <p key={index}>{block.text}</p>
        )
      )}
    </div>
  );
}
