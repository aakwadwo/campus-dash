/**
 * Places test orders against the local database.
 *
 * This used to be an API route. It is a script because a debug endpoint that
 * only 404s in production is still a debug endpoint in the bundle — and the
 * only thing that ever called it was a developer at a terminal.
 *
 * It talks to Postgres directly with the same functions the application uses,
 * so prices are snapshotted and fees are server-calculated exactly as they will
 * be for a real customer.
 *
 *   node scripts/seed-orders.mjs [count] [DELIVERY|PICKUP]
 */
import pg from 'pg';

const [, , countArg, fulfilmentArg] = process.argv;
const count = Number(countArg ?? 1);
const fulfilment = (fulfilmentArg ?? 'DELIVERY').toUpperCase();

const client = new pg.Client({
  host: process.env.TEST_PGHOST || '127.0.0.1',
  port: Number(process.env.TEST_PGPORT || 54322),
  database: 'postgres',
  user: 'postgres',
  password: 'postgres',
});

await client.connect();

try {
  const { rows: vendors } = await client.query(
    `select id, name from public.vendors
      where status = 'ACTIVE' and is_accepting_orders order by name limit 1`
  );
  if (!vendors.length) throw new Error('no open vendor — is the database seeded?');
  const vendor = vendors[0];

  const { rows: staff } = await client.query('select user_id from public.vendor_users');
  const excluded = new Set(staff.map((row) => row.user_id));
  const { rows: users } = await client.query(
    'select id, full_name from public.users where not is_admin order by created_at'
  );
  const customer = users.find((user) => !excluded.has(user.id)) ?? users[0];
  if (!customer) throw new Error('no customer — is the database seeded?');

  const { rows: items } = await client.query(
    `select id from public.menu_items
      where vendor_id = $1 and is_available order by sort_order limit 2`,
    [vendor.id]
  );
  const { rows: locations } = await client.query(
    `select id from public.locations where is_deliverable and is_active order by sort_order limit 1`
  );

  for (let i = 0; i < count; i += 1) {
    const { rows } = await client.query(
      'select * from public.submit_order_for($1, $2, $3, $4::jsonb, $5, $6)',
      [
        customer.id,
        vendor.id,
        fulfilment,
        JSON.stringify(
          items.map((item, index) => ({ menu_item_id: item.id, quantity: index + 1 }))
        ),
        fulfilment === 'DELIVERY' ? locations[0]?.id : null,
        null,
      ]
    );
    const order = rows[0];
    console.log(
      `${order.order_number}  ${vendor.name}  ${fulfilment}  ` +
        `GH₵${(order.total_pesewas / 100).toFixed(2)}  for ${customer.full_name}`
    );
  }
} finally {
  await client.end();
}
