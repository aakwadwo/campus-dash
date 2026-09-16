# Manual end-to-end testing

Everything here is **development only**. The accounts, the passcodes and the
inbox page do not exist in a production build.

Two ways to run it:

- **Local stack** — the seeded accounts, vendors, menus and locations below.
  Fastest, and what the rest of this page assumes.
- **Hosted project** — real persistence, but **no seed**. You create the
  administrator with `npm run admin:create`, then build the campus tree through
  `/admin`, and each actor signs up once so an account exists. Set that up first
  with [`HOSTED-SUPABASE.md`](./HOSTED-SUPABASE.md); the lifecycle below is then
  identical. SMS codes still arrive at `/dev/inbox`; email codes go to whatever
  SMTP the project is configured with.

## Before you start

```bash
npm run db:start          # if Supabase is not already up
npm run db:reset          # migrations + seed, from empty
npm run seed:documents    # placeholder ID/selfie images for the Partner queue
npm run dev
```

`db:reset` wipes all orders. `seed:documents` must be re-run after every reset —
the document _paths_ are seeded but the image _files_ are not, and without them
the Partner approval screen has nothing to show.

## Signing in — three doors

**CUSTOMER — a code to a school address.**

1. Go to **http://localhost:3000/login**
2. Enter the `@acity.edu.gh` address from the table below
3. Open **http://127.0.0.1:54324** (Mailpit) and read the six-digit code
4. Type it in

**VENDOR — a code by SMS.**

1. Go to **http://localhost:3000/login/vendor**
2. Enter the number below (the `020 …` form is what the field expects)
3. Open **http://localhost:3000/dev/inbox** in another tab and read the code
4. Type it in

**ADMIN — an email address and a password**, at
**http://localhost:3000/login/admin**. Operational access must not depend on a
message arriving. The seeded local admin is `admin@acity.edu.gh` with the
password `campusdash`; `npm run admin:create` makes another. **The admin has no
phone number at all** — that is the point, not an omission. `/login/admin` is
not linked from any page: type it.

The SMS inbox holds the last 25 messages, newest first, in server memory only.
Restarting `npm run dev` clears it. It returns **404** in a production build and
whenever `SMS_PROVIDER` is not `fake` — see `tests/dev-inbox.test.js`.

Mailpit is part of the local Supabase stack and holds email regardless.

Use a separate browser profile (or a private window) per role. They are separate
sessions, and signing in as the vendor in the same profile will sign the
customer out.

## Development accounts

**Customers sign in with the address. Vendors sign in with the number.**

| Capabilities            | Sign in with                        | Name                | Where they land       |
| ----------------------- | ----------------------------------- | ------------------- | --------------------- |
| Admin                   | `admin@acity.edu.gh` + `campusdash` | Dev Admin           | `/admin`              |
| Vendor (Kitchen One)    | `0200000011`                        | Muni Owner          | `/vendor`             |
| Vendor (Grill Two)      | `0200000012`                        | Grill Owner         | `/vendor`             |
| Vendor, awaiting review | `0200000013`                        | Pending Owner       | `/vendor/application` |
| Vendor, rejected        | `0200000014`                        | Rejected Owner      | `/vendor/application` |
| Customer                | `ama@acity.edu.gh`                  | Ama Test-Customer   | `/order`              |
| Customer                | `kwesi@acity.edu.gh`                | Kwesi Test-Customer | `/order`              |
| Customer + Partner      | `yaw@acity.edu.gh`                  | Yaw Test-Partner    | `/order`              |
| Customer + Partner      | `adjoa@acity.edu.gh`                | Adjoa Test-Partner  | `/order`              |
| Customer, applied       | `kofi@acity.edu.gh`                 | Kofi Test-Applicant | `/order`              |
| Customer, applied       | `kojo@acity.edu.gh`                 | Kojo Test-Applicant | `/order`              |

`efua@acity.edu.gh`, `abena@acity.edu.gh` and `esi@acity.edu.gh` are spare.

**An approved Partner lands on `/order`, not `/partner`** — a Partner is always
also a customer, and carrying a delivery is something you go and look for. The
Partner area is one tap away in the header's AreaSwitcher.

**The two live vendor accounts hold NO Customer capability, and that is
deliberate** — it is the seed demonstrating that a stall is not a shopper. They
also have no email address, because a vendor is never asked for one. Signing in
as one and visiting `/order` shows the marketplace with a prompt to sign up.

**The admin holds no Customer capability either**, but its address IS a school
one, so `Admin + Customer` is reachable: complete sign-up at `/signup` as the
admin and it keeps everything it already had.

**Wafflemania and Yellow Bar have no owner at all.** They are catalogue entries:
listed so a scan can be fetched from them, operating no dashboard, with nobody
able to sign in as them.

Every Partner account is also a Customer — `PARTNER ⇒ CUSTOMER` is a foreign
key. Each area's header carries an **AreaSwitcher** linking to the other areas
the account holds, which is how you get from `/order` to `/partner` without
signing out. A multi-capability account never has to.

### Testing a delivery end to end

Use three DIFFERENT accounts, and never weaken the conflict rules to make it
work:

- **Customer A** places the order — say `ama@acity.edu.gh`.
- **Vendor C** prepares and marks it READY — `0200000011` (by SMS) for Kitchen
  One. There is nothing to accept: the order arrives paid for.
- **Partner B** must be neither the customer nor the owner of that vendor. Adjoa
  (`adjoa@acity.edu.gh`) works for a Kitchen One order placed by Ama.

If an order shows no eligible Partner, the exclusions are working. Check whether
your Partner placed the order, or owns the vendor it came from, before
suspecting a bug.

### The two things most likely to surprise you

**A store sees nothing until the order is paid for.** If you place an order and
the vendor board is empty, that is correct — go and pay it. There is no Accept
button anywhere any more.

**The handoff code is on the STORE's screen**, never on the screen of whoever is
collecting. Open the order in `/vendor/<id>/orders/<orderId>`, read the four
digits out, and type them into the collector's app — the Partner's at
`/partner/delivery` for a delivery, or the customer's own order page for a
collection. The delivery code goes the other way: it is on the customer's order
screen and the Partner types that one in.

**A Partner is offered the job while the food is still cooking.** The offer says
"Still being prepared", and the code box does not appear on their screen until
the store presses Ready.

### Testing Partner capacity

A Partner may carry as many as `/admin/pilot` → **Orders one Partner may carry
at once** allows. The default is 2. Place two delivery orders from different
customers, walk both to READY, and accept both as Adjoa: the Partner home screen
lists both, and `/partner/delivery?order=<id>` switches between them. A third is
refused with "You already have 2 active deliveries."

Change the setting to 3 and try the third again — it is accepted, with no
restart. Change it back to 1 while Adjoa is carrying three: she keeps all three,
and only the NEXT acceptance is refused.

### Testing the rating prompt

Complete a delivery. The customer's order screen offers five stars straight
away. Submit one and reload: the prompt is gone and does not return. The Partner
sees the average on `/partner`; individual ratings are visible only to the
customer who left one and to an administrator, at `/admin/community`.

### Testing the reward tracker

The tracker appears under `/orders` and on `/account` once a customer has one
completed order. Marks sit at 25, 40 and 50. To see a milestone without placing
fifty orders, complete some directly against the local database:

```sql
-- local development only
do $$ declare i int; v uuid; begin
  for i in 1..25 loop
    insert into public.orders (customer_id, vendor_id, order_status, payment_status,
      delivery_status, fulfilment_type, subtotal_pesewas, service_fee_pesewas,
      delivery_fee_pesewas, total_pesewas, submitted_at, accepted_at)
    values ('<customer uuid>', '<vendor uuid>', 'READY', 'PAID', 'NONE', 'PICKUP',
            1000, 50, 0, 1050, now(), now()) returning id into v;
    update public.orders set order_status = 'COMPLETED', completed_at = now() where id = v;
  end loop;
end $$;
```

Reaching 50 writes one `customer_rewards` row and shows the unlocked message.
The 51st writes nothing.

### Testing the vendor journey

Register a new store at `/vendor/signup` with an unused number — the form comes
first, the SMS code second. Approve or reject it from `/admin/vendors`. A
rejection needs a reason, and that reason is what the applicant sees at
`/vendor/application`; correcting and resubmitting puts it back in the queue.

## Timings

The seed widens three windows **for manual testing only**, because a human
switching between four browser profiles cannot beat the real ones:

| Setting               | Seeded for manual use | Production intent |
| --------------------- | --------------------- | ----------------- |
| Partner search window | 30 min                | 10 min            |
| Customer-absent wait  | 60 s                  | 5 min             |
| Payment timeout       | 5 min                 | 15 min            |

Change any of them live at `/admin/pilot`. The automated tests set their own
values and ignore these.

**The payment timeout is also the pay-by deadline.** An order somebody prices
and never pays for is CANCELLED by the sweep once it passes — set it short at
`/admin/pilot` if you want to watch that happen.

## The full lifecycle

Prices: **6.95% Campus Dash fee** on the food, **GH₵5** flat for a Partner.
A Jollof (GH₵35) carried by a Partner costs GH₵35.00 + GH₵2.43 + GH₵5.00 =
**GH₵42.43**. Collected, it costs **GH₵37.43** — the GH₵5 is added when, and
only when, the customer asks for a Partner.

1. **Customer** `/order` → Test Kitchen One → add items → **Checkout**. Choose
   **Campus Dash Partner** and a room (Room 101/102/204/205). The total moves to
   GH₵42.43 as you choose; collecting instead reads GH₵37.43. Press **Pay**.
2. **Payment** opens, and the fake provider settles itself after ~2 seconds.
   Stay on the order page — the page poll is what delivers its callback.
3. **Vendor** `/vendor` → the order appears **already paid**, in **To prepare**,
   with a queue number (`001`). There is no Accept button.
4. **Partner** `/partner` → go online → `/partner/offers`. The offer is ALREADY
   THERE, marked **Still being prepared**: the pool opened when the money
   landed. Accept it. The offer shows a zone, never a room; the moment it is
   accepted the Partner dashboard shows the **room, the customer's first name
   and a Call button**. A Partner may hold TWO at a time; a third is refused.
5. **Vendor** → **Ready for pickup**. The Partner's screen now says "Collect
   from Test Kitchen One" and a code box appears.
6. **Pickup** — the **vendor** opens the order and reads out the 4-digit code;
   the **Partner** types it in at `/partner/delivery`.
7. **Delivery** — the **customer** reads out their delivery code at
   `/orders/[id]`; the **Partner** types it in. Order completes, GH₵5 lands in
   the Partner's earnings, and the customer's phone number disappears from the
   Partner's view immediately.
8. **Admin** `/admin/money` → the order splits vendor / Partner / platform and
   sums to the total. `/admin/settlements` → create a run and pay it out.
9. **Admin, verifying the data rather than the screen** — `/admin/orders/[id]`
   shows the three state dimensions, the allocations, the event log and the
   notifications for one order. For the rows themselves, Supabase Studio
   (http://127.0.0.1:54323) or the hosted table editor: `orders`, `allocations`,
   `payments`, `payouts`, `order_events`, `notification_events`, `admin_actions`.

### Also worth walking

- **Partner approval** — Admin `/admin/partners` → Kofi Test-Applicant → the ID
  and selfie panels render placeholder images via short-lived signed URLs →
  approve or reject. An approval texts the applicant a link to their dashboard.
- **Vendor approval** — Admin `/admin/vendors` → Pending Provisions → approve.
  The store becomes ACTIVE and stays **closed** until its owner opens it.
- **Vendor storefront** — sign in as a vendor, `/vendor/profile`, upload a photo
  and change the category. Both appear on `/order` immediately.
- **Collection order** — choose "Collect it yourself" at the checkout. No
  Partner, no delivery fee. The **vendor** reads a code off their screen and the
  **customer** types it into their own order page.
- **Letting an order go unpaid** — place one and walk away. The sweep cancels it
  once the payment timeout passes, and nothing is charged.
- **Sold out** — vendor `/vendor/menu` → mark the Jollof sold out. It stays on
  the customer menu, marked **Sold out**, and cannot be added. Close the store
  and open it again: everything is available once more.
- **Partner delivery switched off** — Admin `/admin/pilot` → untick **Partner
  delivery is available**. New checkouts offer collection only; an order already
  paid for is untouched and still completes.
- **Scan pricing** — a meal scan is priced by its OWN rules, and the 6.95% food
  percentage is never part of it. Every scan order pays a flat **GH₵2.00**
  service fee whatever the meal is worth. Place three at `/scan` and watch the
  total:

  | What you choose                | Fees                        | Total    |
  | ------------------------------ | --------------------------- | -------- |
  | Collect it yourself, no pack   | GH₵2.00                     | GH₵2.00  |
  | Collect it yourself, with pack | GH₵2.00 + GH₵4.00           | GH₵6.00  |
  | Campus Dash Partner            | GH₵2.00 + GH₵4.00 + GH₵5.00 | GH₵11.00 |

  The food itself is GH₵0.00 on all three — the scan pays the store for that.

- **Pack fee** — GH₵4.00, and whether it is a choice depends on how the order
  is being collected. On **collect it yourself** there is a checkbox, off by
  default: leave it off if you are bringing your own container and the pack line
  does not appear. With a **Campus Dash Partner** it is compulsory and there is
  no "no pack" option to find — a Partner needs something to carry. Tick the box
  on a collection, then switch to a Partner and back, and watch the control
  change. When it is charged it is always its own line on the checkout and on
  the order. A food order never shows one, and a CHECK constraint is what says
  so.
- **Stuck payment** — restart `npm run dev` while a payment is pending. The
  fake provider's in-memory record is lost, so it hangs; after the payment
  timeout the customer can abandon it and retry, and a sweep runs every 15 min.
- **Pilot metrics** — `/admin/pilot`, which also shows whether the pg_cron
  sweeps are actually running and what they last returned.

### The failure paths worth walking by hand

Each of these is covered by an automated test as well; walking them is about
seeing what the person on the other end actually sees.

| Scenario                       | How to produce it                                                                                                                                                                       |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vendor never answers           | Place an order, leave it. It expires after the vendor window; no charge was ever taken.                                                                                                 |
| Vendor rejects                 | Reject from the vendor board. Order closes; it cannot be revived.                                                                                                                       |
| Payment stays pending          | Restart `npm run dev` mid-payment. The fake provider's in-memory record is lost, so it hangs until the timeout or the sweep.                                                            |
| Payment succeeds               | The default path — stay on the order page so the poll delivers the callback.                                                                                                            |
| Second Partner races the first | Two Partner profiles, both online, both on `/partner/offers`. One wins; the other is told plainly.                                                                                      |
| Partner cancels before handoff | `/partner/delivery` → cancel. Delivery returns to SEARCHING, the slot is freed, the pickup code rotates, the order and the vendor are untouched.                                        |
| Old pickup code is dead        | Note the vendor's code before cancelling. After a second Partner takes it, the code has changed and the old one is refused.                                                             |
| Customer absent                | Partner reports absence; the customer has the absent-wait window to respond.                                                                                                            |
| Customer disputes              | `/orders/[id]` after delivery → dispute. Admin resolves at `/admin/orders/[id]`.                                                                                                        |
| Duplicate webhook              | Re-post the same provider event id to `/api/payments/webhook/fake`. The second is deduplicated, not charged.                                                                            |
| Duplicate payment request      | Press pay twice. One live intent per order is a partial unique index, not a UI guard.                                                                                                   |
| Duplicate payout               | Create a settlement run twice for the same period. Refused by the payout uniqueness index.                                                                                              |
| Wrong role                     | Sign in as a customer and open `/vendor`, `/partner` or `/admin`.                                                                                                                       |
| Capacity refused               | One Partner accepts up to the configured maximum, then tries one more. "You already have N active deliveries."                                                                          |
| Wrong code, repeatedly         | Type five wrong pickup codes. The handoff locks out for five minutes, and the CORRECT code is refused too until it expires.                                                             |
| Rating cannot be repeated      | Rate a completed delivery, then call the action again. Refused: the order is the primary key.                                                                                           |
| Vendor rejected, then fixed    | Reject a store with a reason at `/admin/vendors`. Sign in as the owner: the reason is on `/vendor/application`, and the form at `/vendor/signup` is pre-loaded to correct and resubmit. |
| Customer with a wrong domain   | Try signing up with a non-`@acity.edu.gh` address, and with `x@acity.edu.gh.example.com`. Both are refused.                                                                             |

## Resetting

```bash
npm run db:reset && npm run seed:documents
```

`npm run seed:orders [count] [DELIVERY|PICKUP]` places orders without the UI.
