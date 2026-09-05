import { Container, Skeleton } from '../../ui';

/** The menu's shape. Public route — see the note in app/order/loading.js. */
export default function VendorLoading() {
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading menu</span>
      <div className="border-line h-16 border-b" />
      <div className="border-line border-b">
        <Container size="wide" className="pt-6 pb-7">
          <Skeleton className="h-5 w-28" />
          <div className="mt-5 flex items-center gap-5">
            <Skeleton className="rounded-card size-20 sm:size-28" />
            <div className="flex-1">
              <Skeleton className="h-8 w-2/3 max-w-xs" />
              <Skeleton className="mt-3 h-4 w-40" />
            </div>
          </div>
        </Container>
      </div>
      <Container size="wide" className="pt-8">
        <div className="grid gap-3 md:grid-cols-2">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="rounded-card h-28 w-full" />
          ))}
        </div>
      </Container>
    </div>
  );
}
