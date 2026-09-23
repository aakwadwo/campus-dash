import './helpers/local-supabase.js';

import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { withRequestCookies } from './helpers/stubs/next-headers.mjs';
import { seededVendorSession } from './helpers/sessions.js';
import { asService, resetTransactionalState, closePools, ACTORS, VENDORS } from './helpers/db.js';

import { setMenuItemActiveAction } from '@/app/vendor/actions';

/**
 * The menu switch moves on the tap and the database decides where it lands.
 *
 * The client half is useOptimistic: it holds the tapped position only while
 * the action runs, then yields to the page the server rendered. That is safe
 * only if the action ANSWERS a refusal rather than throwing, so the row can fall
 * back and say why. The first describe holds the action to that; the second
 * holds the component to the shape that makes the switch honest.
 */
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

describe('the menu switch', () => {
  let vendor;

  before(async () => {
    await resetTransactionalState();
    vendor = await seededVendorSession(ACTORS.vendor1Staff);
  });
  beforeEach(resetTransactionalState);
  after(async () => {
    await vendor.restore();
    await resetTransactionalState();
    await closePools();
  });

  const toggle = (id, active, name = 'That item') => {
    const form = new FormData();
    form.set('menu_item_id', id);
    form.set('vendor_id', VENDORS.one);
    form.set('name', name);
    form.set('active', String(active));
    return withRequestCookies(vendor.cookies, () => setMenuItemActiveAction({}, form));
  };

  const saved = (id) =>
    asService(
      async (c) =>
        (await c.query('select is_active from public.menu_items where id = $1', [id])).rows[0]
          ?.is_active
    );

  describe('the action answers a refusal instead of throwing', () => {
    // Success is proven where it is decided, in vendor-menu.test.js: the saved
    // state, and the store opening and closing with its menu. A successful call
    // here would reach revalidatePath(), which needs a real Next request.
    test('a refusal comes back as { ok: false } with a message, not a throw, and saves nothing', async () => {
      // An item that no longer exists: the database refuses, the switch must
      // fall back to where it was, and the vendor must be told why.
      const result = await toggle('00000000-0000-4000-8000-00000000dead', true);
      assert.equal(result.ok, false);
      assert.equal(result.message, 'We could not find that.');
    });

    test('another store’s item is refused the same way, and is not touched', async () => {
      const other = await asService(
        async (c) =>
          (
            await c.query(
              'select id, is_active from public.menu_items where vendor_id = $1 limit 1',
              [VENDORS.two]
            )
          ).rows[0]
      );
      const result = await toggle(other.id, !other.is_active);
      assert.equal(result.ok, false);
      assert.equal(await saved(other.id), other.is_active);
    });
  });

  describe('the switch is optimistic, and only while the database is deciding', () => {
    const source = read('app/vendor/menu/menu-manager.js');
    const row = source.slice(
      source.indexOf('function MenuRow('),
      source.indexOf('function Switch(')
    );

    test('it shows the tapped position from inside the action, on top of the saved one', () => {
      assert.match(row, /useOptimistic\(item\.is_active\)/, 'the saved state is the base');
      assert.match(
        row,
        /useActionState\(async \(previous, formData\) => \{\s*showOn\(/,
        'set inside the action, so it lasts exactly as long as the action does'
      );
      assert.match(
        row,
        /await setMenuItemActiveAction\(previous, formData\)/,
        'the server decides'
      );
    });

    test('a request that never comes back is a failure the row can show', () => {
      assert.match(row, /catch \{[\s\S]*?ok: false, message:/);
    });

    test('a tap asks for the opposite of what is SAVED, never of what is shown', () => {
      assert.match(row, /name="active" value=\{item\.is_active \? 'false' : 'true'\}/);
    });

    test('the switch is locked until the last tap is answered', () => {
      assert.match(row, /<Switch on=\{on\} pending=\{switching\}/);
      assert.match(source, /disabled=\{pending\}/);
    });
  });
});
