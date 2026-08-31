import Link from 'next/link';
import { requireUser } from '@/lib/auth/session';
import { listMyOrders } from '@/lib/customer';
import { formatPesewas } from '@/lib/util/money';
import { STAGE } from './stage';

export const metadata = { title: 'My orders · Campus Dash' };
export const dynamic = 'force-dynamic';

export default async function MyOrdersPage() {
  await requireUser('/orders');
  const orders = await listMyOrders();

  return (
    <main className="mx-auto max-w-md px-4 pt-5 pb-16">
      <header className="mb-5 flex items-baseline justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">My orders</h1>
        <Link href="/order" className="text-brand-700 text-sm underline underline-offset-4">
          Order something
        </Link>
      </header>

      {orders.length ? (
        <ul className="space-y-2">
          {orders.map((order) => {
            const stage = STAGE[order.stage];
            return (
              <li key={order.order_id}>
                <Link
                  href={`/orders/${order.order_id}`}
                  className="block rounded-lg bg-white px-4 py-3 ring-1 ring-black/5"
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="font-medium">{order.vendor_name}</span>
                    <span className="tabular-nums">{formatPesewas(order.total_pesewas)}</span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                    <span className={`font-medium ${stage.tone}`}>{stage.label}</span>
                    <span className="text-muted font-mono text-xs">{order.order_number}</span>
                    <span className="text-muted">
                      {order.fulfilment_type === 'PICKUP' ? 'Collect' : 'Delivery'}
                    </span>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-muted py-10 text-center text-sm">
          Nothing yet.{' '}
          <Link href="/order" className="text-brand-700 underline underline-offset-4">
            Place your first order
          </Link>
          .
        </p>
      )}
    </main>
  );
}
