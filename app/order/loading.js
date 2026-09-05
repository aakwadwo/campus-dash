import { Container, CardSkeleton, Skeleton } from '../ui';

/**
 * The shape of the marketplace, before it arrives.
 *
 * Deliberately the SHAPE and not a spinner: a skeleton matching the grid that
 * is coming means nothing jumps when the data lands, and it tells someone on a
 * slow campus connection that a page is being built rather than that a tap was
 * missed.
 *
 * SCOPED TO THE PUBLIC ROUTES ON PURPOSE. A loading.js turns its segment into a
 * streaming response, which means the HTTP status is 200 and any redirect the
 * page performs is delivered in the stream instead of as a 307. On a route
 * guarded by requireUser() that would quietly downgrade the auth boundary from
 * an HTTP redirect to a client-side one — so these belong only where nothing
 * redirects, which is the marketplace: open to everyone, signed in or not.
 */
export default function OrderLoading() {
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading vendors</span>
      <div className="border-line h-16 border-b" />
      <Container size="wide" className="pt-8 sm:pt-12">
        <Skeleton className="h-9 w-32" />
        <Skeleton className="mt-3 h-4 w-56" />
        <Skeleton className="rounded-panel mt-7 h-20 w-full" />
        <Skeleton className="mt-8 h-12 w-full" />
        <div className="mt-7 grid grid-cols-2 gap-x-4 gap-y-7 lg:grid-cols-4">
          {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
            <CardSkeleton key={i} />
          ))}
        </div>
      </Container>
    </div>
  );
}
