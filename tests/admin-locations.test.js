import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  asService,
  asUser,
  resetTransactionalState,
  closePools,
  ACTORS,
  VENDORS,
  LOCATIONS,
} from './helpers/db.js';
import { expectRejection, submitOrder } from './helpers/flow.js';

describe('admin — campus locations', () => {
  before(resetTransactionalState);
  beforeEach(resetTransactionalState);
  after(async () => {
    await resetTransactionalState();
    await closePools();
  });

  const admin = (sql, params) =>
    asUser(ACTORS.admin, async (c) => (await c.query(sql, params)).rows[0], { commit: true });

  const auditFor = (targetId) =>
    asService(
      async (c) =>
        (
          await c.query('select * from public.admin_actions where target_id = $1 order by id', [
            targetId,
          ])
        ).rows
    );

  const CAMPUS = '10000000-0000-4000-8000-000000000001';
  const BLOCK_A = '10000000-0000-4000-8000-000000000010';
  const FLOOR_2 = '10000000-0000-4000-8000-000000000012';

  test('an admin adds a room and a customer can immediately order to it', async () => {
    const room = await admin('select * from public.admin_create_location($1, $2, $3, $4, $5, $6)', [
      'ROOM',
      'TEST Room 999',
      'new room came online',
      FLOOR_2,
      true,
      null,
    ]);
    assert.equal(room.name, 'TEST Room 999');
    assert.equal(room.is_deliverable, true);
    assert.equal(room.is_active, true);

    const order = await submitOrder({ destination: room.id });
    assert.ok(order.order_id);

    // The Partner offer must resolve the block-level zone, not the room.
    const stored = await asService(
      async (c) =>
        (
          await c.query('select destination_zone_id from public.orders where id = $1', [
            order.order_id,
          ])
        ).rows[0]
    );
    assert.equal(stored.destination_zone_id, BLOCK_A);

    const audit = await auditFor(room.id);
    assert.equal(audit[0].action, 'LOCATION_CREATE');
  });

  test('a non-CAMPUS location cannot be created without a parent', async () => {
    const error = await expectRejection(
      admin('select * from public.admin_create_location($1, $2, $3)', [
        'ROOM',
        'TEST Orphan Room',
        'no parent',
      ])
    );
    assert.match(error.message, /only a CAMPUS may be a root location/);
  });

  test('a customer cannot create or edit locations', async () => {
    const create = await expectRejection(
      asUser(ACTORS.customerAma, (c) =>
        c.query('select public.admin_create_location($1, $2, $3, $4)', [
          'ROOM',
          'TEST Fake Room',
          'trying it on',
          FLOOR_2,
        ])
      )
    );
    assert.match(create.message, /admin privileges required/);

    const update = await expectRejection(
      asUser(ACTORS.customerAma, (c) =>
        c.query('select public.admin_update_location($1, $2, $3)', [
          LOCATIONS.room204,
          'renaming',
          'My Room',
        ])
      )
    );
    assert.match(update.message, /admin privileges required/);

    const direct = await expectRejection(
      asUser(ACTORS.customerAma, (c) =>
        c.query('update public.locations set is_deliverable = true where id = $1', [FLOOR_2])
      )
    );
    assert.match(direct.message, /permission denied/i);
  });

  test('marking a floor deliverable makes it a valid destination', async () => {
    const before = await expectRejection(submitOrder({ destination: FLOOR_2 }));
    assert.match(before.message, /not a valid delivery location/);

    await admin('select * from public.admin_update_location($1, $2, null, $3)', [
      FLOOR_2,
      'floor-level drop-off allowed here',
      true,
    ]);

    const order = await submitOrder({ destination: FLOOR_2 });
    assert.ok(order.order_id);
  });

  test('deactivating a block deactivates everything beneath it', async () => {
    await admin('select * from public.admin_set_location_active($1, false, $2)', [
      BLOCK_A,
      'block closed for works',
    ]);

    const descendants = await asService(
      async (c) =>
        (
          await c.query(
            `with recursive d as (
           select id, is_active from public.locations where parent_id = $1
           union all
           select l.id, l.is_active from public.locations l join d on l.parent_id = d.id
         ) select * from d`,
            [BLOCK_A]
          )
        ).rows
    );
    assert.ok(descendants.length > 0);
    assert.ok(
      descendants.every((l) => !l.is_active),
      'no room is left selectable under a closed block'
    );

    const error = await expectRejection(submitOrder({ destination: LOCATIONS.room204 }));
    assert.match(error.message, /not a valid delivery location/);
  });

  test('deactivating does not disturb an order already heading there', async () => {
    const order = await submitOrder({ destination: LOCATIONS.room204 });

    await admin('select * from public.admin_set_location_active($1, false, $2)', [
      BLOCK_A,
      'block closed after the order was placed',
    ]);

    const stored = await asService(
      async (c) =>
        (await c.query('select * from public.orders where id = $1', [order.order_id])).rows[0]
    );
    assert.equal(
      stored.destination_location_id,
      LOCATIONS.room204,
      'the Partner still needs the room'
    );
    assert.equal(stored.order_status, 'SUBMITTED');
  });

  test('reactivating a block is audited and restores it', async () => {
    await admin('select * from public.admin_set_location_active($1, false, $2)', [
      BLOCK_A,
      'closed',
    ]);
    await admin('select * from public.admin_set_location_active($1, true, $2)', [
      BLOCK_A,
      'works finished',
    ]);

    const stored = await asService(
      async (c) =>
        (await c.query('select is_active from public.locations where id = $1', [BLOCK_A])).rows[0]
    );
    assert.equal(stored.is_active, true);

    const audit = await auditFor(BLOCK_A);
    assert.ok(audit.some((a) => a.action === 'LOCATION_DEACTIVATE'));
    assert.ok(audit.some((a) => a.action === 'LOCATION_ACTIVATE'));
  });

  test('an unused location can be deleted', async () => {
    const room = await admin('select * from public.admin_create_location($1, $2, $3, $4, $5)', [
      'ROOM',
      'TEST Delete Me',
      'created by mistake',
      FLOOR_2,
      true,
    ]);

    const deleted = await admin('select public.admin_delete_location($1, $2) as ok', [
      room.id,
      'removing a mistake',
    ]);
    assert.equal(deleted.ok, true);

    const audit = await auditFor(room.id);
    assert.ok(audit.some((a) => a.action === 'LOCATION_DELETE'));
  });

  test('a location with children cannot be deleted', async () => {
    const error = await expectRejection(
      admin('select public.admin_delete_location($1, $2)', [BLOCK_A, 'tidying up'])
    );
    assert.match(error.message, /child location\(s\)\. Deactivate it instead\./);
  });

  test('a location an order points at cannot be deleted', async () => {
    await submitOrder({ destination: LOCATIONS.room204 });
    const error = await expectRejection(
      admin('select public.admin_delete_location($1, $2)', [LOCATIONS.room204, 'tidying up'])
    );
    assert.match(error.message, /order\(s\) reference this location/);
  });

  test('a location a vendor sits at cannot be deleted', async () => {
    // A childless leaf, so the child-count guard cannot mask the vendor guard.
    const spot = await admin('select * from public.admin_create_location($1, $2, $3, $4)', [
      'COMMON_AREA',
      'TEST Vendor Stall Spot',
      'new stall pitch',
      FLOOR_2,
    ]);
    await admin('select * from public.admin_update_vendor($1, $2, null, null, $3)', [
      VENDORS.one,
      'moved to the new pitch',
      spot.id,
    ]);

    const error = await expectRejection(
      admin('select public.admin_delete_location($1, $2)', [spot.id, 'tidying up'])
    );
    assert.match(error.message, /vendor\(s\) sit at this location/);
  });

  test('two siblings cannot share a name', async () => {
    const error = await expectRejection(
      admin('select * from public.admin_create_location($1, $2, $3, $4, $5)', [
        'ROOM',
        'room 204',
        'duplicate',
        FLOOR_2,
        true,
      ])
    );
    assert.match(error.message, /locations_sibling_name_unique/);
  });

  test('the tree cannot be made cyclic', async () => {
    const error = await expectRejection(
      asService((c) =>
        c.query('update public.locations set parent_id = $1 where id = $2', [FLOOR_2, BLOCK_A])
      )
    );
    assert.match(error.message, /location cycle detected/);
  });

  test('a campus can be created as a root', async () => {
    const campus = await admin('select * from public.admin_create_location($1, $2, $3)', [
      'CAMPUS',
      'TEST Second Campus',
      'expansion site',
    ]);
    assert.equal(campus.parent_id, null);
    assert.equal(campus.kind, 'CAMPUS');
    assert.ok(CAMPUS);
  });
});
