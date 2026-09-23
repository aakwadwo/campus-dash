import './helpers/local-supabase.js';

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { asService, asAnon, closePools, VENDORS } from './helpers/db.js';
import { ALLOWED_SCAN_MIME_TYPES } from '@/lib/verification/documents';

/**
 * A MEAL SCAN IS A SWITCH ON A CHECKOUT, NOT A PLACE TO GO.
 *
 * The rules in this file are the ones that live above SQL — what a browser may
 * upload, what the checkout offers and where — so they are checked where they
 * are decided rather than only through a page that happens to render.
 * Everything about STATE is in scan-delivery.test.js, which is where the
 * database is the thing under test.
 */
after(closePools);

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

describe('the Meal Scan is a photograph', () => {
  /**
   * PDF IS GONE, and this is the assertion that keeps it gone.
   *
   * It was accepted because some entitlements are issued that way, which was
   * true and cost more than it was worth: the customer could not preview what
   * they were about to send, the store had to open a document viewer at a
   * counter, and "choose a file" opened a document picker on a phone when what
   * everybody wanted was the camera roll. A screenshot of a PDF is a
   * photograph, and every phone takes one in two taps.
   */
  test('only image types are accepted, and PDF is not one of them', () => {
    assert.deepEqual(
      [...ALLOWED_SCAN_MIME_TYPES].sort(),
      ['image/jpeg', 'image/png', 'image/webp'],
      'photographs only'
    );
    assert.equal(ALLOWED_SCAN_MIME_TYPES.has('application/pdf'), false);
  });

  test('the upload refuses anything else before it reaches storage', () => {
    const source = read('lib/verification/documents.js');
    const upload = source.slice(source.indexOf('export async function uploadScan'));

    assert.match(upload, /SCAN_ALLOWED\.has\(file\.type\)/, 'the type is checked');
    assert.match(upload, /photo of your Meal Scan/, 'and the refusal names the two buttons');
    // THE CHECK COMES FIRST. A file written to the bucket and then rejected is
    // a file in the bucket.
    assert.ok(
      upload.indexOf('SCAN_ALLOWED') < upload.indexOf('.upload('),
      'refused before it is stored'
    );
  });

  /**
   * TWO ROUTES, AND NEITHER IS A DOCUMENT PICKER. `accept="image/*"`-style
   * image types are what make a phone open the camera roll; the capture
   * component is what opens the camera.
   */
  test('the checkout offers exactly "Choose a photo" and "Take a photo"', () => {
    const source = read('app/order/[vendorId]/menu-and-basket.js');

    assert.match(source, /Choose a photo/, 'the library');
    assert.match(source, /Take a photo/, 'the camera');
    assert.match(source, /accept="image\/jpeg,image\/png,image\/webp"/, 'images only');
    assert.equal(source.includes('application/pdf'), false, 'no document route');
    assert.match(source, /<CameraCapture/, 'and the camera goes through the shared component');
  });

  /**
   * THE PREVIEW IS THE POINT. The customer sees the actual image before they
   * pay, and can replace it as many times as they like — until the order
   * exists. After that the scan is fixed; see scan-delivery.test.js for the
   * database half of that.
   */
  test('the photo is previewed, and can be changed before submission', () => {
    const source = read('app/order/[vendorId]/menu-and-basket.js');

    assert.match(source, /URL\.createObjectURL\(file\)/, 'a real preview of the real file');
    assert.match(source, /Choose another photo/, 'replaceable');
    assert.match(source, /Retake photo/, 'and retakeable');
    assert.match(source, /revokeObjectURL/, 'without pinning every attempt');
  });

  test('the warning about a non-refundable payment is shown before paying', () => {
    const source = read('app/order/[vendorId]/menu-and-basket.js');
    const warning = source.slice(source.indexOf('Make sure your Meal Scan'));

    assert.match(warning, /clear and fully visible/);
    assert.match(warning, /non-refundable/);
    // IT SITS INSIDE THE MEAL SCAN SECTION, so it appears only when the switch
    // is on — a warning about scans on an ordinary food checkout is noise.
    assert.ok(
      source.indexOf('Make sure your Meal Scan') > source.indexOf('function MealScanSection'),
      'inside the section the switch reveals'
    );
  });
});

describe('the browsing mode is gone', () => {
  /**
   * The separate catalogue made a student decide how they were paying before
   * they had decided what to eat, and one who did not know the feature existed
   * never found it.
   */
  test('there is no /scan route left', () => {
    for (const path of [
      'app/scan/page.js',
      'app/scan/[vendorId]/page.js',
      'app/scan/[vendorId]/scan-order-builder.js',
      'app/scan/actions.js',
    ]) {
      assert.throws(() => read(path), `${path} should not exist`);
    }
  });

  test('nothing links to one', () => {
    for (const path of ['app/page.js', 'app/order/page.js', 'app/robots.js']) {
      const source = read(path);
      assert.equal(source.includes("'/scan'"), false, path);
      assert.equal(source.includes('"/scan"'), false, path);
    }
  });

  /**
   * WHAT REPLACED IT. One list of stores, and a store that takes a Meal Scan
   * says so on its own page — from can_accept_scans, which only an
   * administrator sets.
   */
  test('the store page says Meal Scan accepted, from the store flag', () => {
    const source = read('app/order/[vendorId]/page.js');
    assert.match(source, /vendor\.can_accept_scans/, 'read from the store');
    assert.match(source, /Meal Scan accepted/);
  });

  test('the switch is offered only where the store takes one, and starts off', () => {
    const source = read('app/order/[vendorId]/menu-and-basket.js');

    assert.match(source, /const \[mealScan, setMealScan\] = useState\(false\)/, 'off by default');
    assert.match(
      source,
      /const scanOffered = Boolean\(vendor\.can_accept_scans\)/,
      'and offered only where the store accepts one'
    );
    assert.match(source, /Redeem by Meal Scan/);
  });

  /**
   * ELIGIBILITY IS THE ADMINISTRATOR'S, and nobody else's. A vendor has no
   * function that touches can_accept_scans; the only writer is the audited
   * admin one.
   */
  test('only an administrator can make a store accept Meal Scans', async () => {
    const writers = await asService(async (c) =>
      (
        await c.query(
          `select p.proname
               from pg_proc p
               join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public'
                and p.prokind = 'f'
                -- pg_get_functiondef() refuses an aggregate, and the catalogue
                -- is full of them. Only our own SQL and PL/pgSQL is in scope.
                and p.prolang <> (select oid from pg_language where lanname = 'internal')
                and pg_get_functiondef(p.oid) ilike '%can_accept_scans =%'`
        )
      ).rows.map((r) => r.proname)
    );
    assert.deepEqual(writers, ['admin_set_vendor_scans'], 'one writer, and it is the admin one');
  });

  test('the storefront read carries scan eligibility, so the checkout can mark items', async () => {
    const menu = await asAnon(
      async (c) =>
        (
          await c.query('select id, scan_eligible from public.menu_items where vendor_id = $1', [
            VENDORS.wafflemania,
          ])
        ).rows
    );
    assert.ok(menu.length > 0);
    assert.ok(
      menu.some((item) => item.scan_eligible === true),
      'the store honours a Meal Scan for at least one thing'
    );
    assert.ok(
      menu.some((item) => item.scan_eligible === false),
      'and deliberately not for everything'
    );
  });
});

describe('the Partner is told nothing about a Meal Scan', () => {
  test('no Partner screen reads a scan', () => {
    for (const path of ['app/partner/delivery/page.js', 'app/partner/offers/offer-list.js']) {
      const source = read(path);
      assert.equal(source.includes('scanImageUrl'), false, path);
      assert.equal(source.includes('getPartnerScanBrief'), false, path);
      assert.equal(source.includes('ScanCollection'), false, path);
    }
    assert.throws(
      () => read('app/partner/delivery/scan-collection.js'),
      'the component that showed it is gone'
    );
  });

  test('the scan library offers a Partner nothing to call', () => {
    const source = read('lib/scan/index.js');
    assert.equal(source.includes('getPartnerScanBrief'), false);
    assert.equal(source.includes('partner_scan_brief'), false);
    assert.equal(source.includes('listScanRestaurants'), false, 'nor a scan catalogue');
    assert.equal(source.includes('scan_menu'), false);
  });
});
