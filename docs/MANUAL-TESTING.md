# Manual end-to-end testing

Everything here is **development only**. The accounts, the passcodes and the
inbox page do not exist in a production build.

Two ways to run it:

- **Local stack** — the seeded accounts, vendors, menus and locations below.
  Fastest, and what the rest of this page assumes.
- **Hosted project** — real persistence, but **no seed**. You create the
  administrator with `npm run admin:create`, then build the campus tree, the
  vendors and the menus through `/admin`, and each actor signs in by phone once
  so an account exists. Set that up first with
  [`HOSTED-SUPABASE.md`](./HOSTED-SUPABASE.md); the lifecycle below is then
  identical, and OTPs still arrive at `/dev/inbox`.

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

## Signing in

Customers, vendors and Partners use phone OTP.

1. Go to **http://localhost:3000/login**
2. Enter the number below (the `020 …` form is what the field expects)
3. Open **http://localhost:3000/dev/inbox** in another tab and read the code
4. Type it in

Administrators sign in at **http://localhost:3000/login/admin** with an email
and password instead, because operational access must not depend on an SMS
arriving. The seeded local admin has no password; give it one — or create a
second administrator — with `npm run admin:create`. The seeded admin phone
(`0200000001`) still works at `/login` as well.

The inbox holds the last 25 messages, newest first, in server memory only.
Restarting `npm run dev` clears it. It returns **404** in a production build and
whenever `SMS_PROVIDER` is not `fake` — see `tests/dev-inbox.test.js`.

Use a separate browser profile (or a private window) per role. They are separate
sessions, and signing in as the vendor in the same profile will sign the
customer out.

## Development accounts

| Capabilities         | Phone        | Name                | Where they land  |
| -------------------- | ------------ | ------------------- | ---------------- |
| Admin                | `0200000001` | Dev Admin           | `/admin`         |
| Vendor (Kitchen One) | `0200000011` | Muni Owner          | `/vendor`        |
| Vendor (Grill Two)   | `0200000012` | Grill Owner         | `/vendor`        |
| Customer             | `0200000021` | Ama Test-Customer   | `/order`         |
| Customer             | `0200000022` | Kwesi Test-Customer | `/order`         |
| Customer + Partner   | `0200000031` | Yaw Test-Partner    | `/partner`       |
| Customer + Partner   | `0200000032` | Adjoa Test-Partner  | `/partner`       |
| Customer, applied    | `0200000033` | Kofi Test-Applicant | `/partner/apply` |
| Customer, applied    | `0200000035` | Kojo Test-Applicant | `/partner/apply` |

Customers `0200000023` / `0200000024` and Partner `0200000034` are spare.

**The admin and the two vendor accounts hold NO Customer capability, and that is
deliberate** — it is the seed demonstrating that admin does not imply customer
and that a stall is not a shopper. Signing in as any of them and visiting
`/order` shows the marketplace with a prompt to add student details, and
`/orders` redirects to `/onboarding`. Give one the capability by completing
onboarding as that account; it keeps everything it already had.

Every Partner account is also a Customer — `PARTNER ⇒ CUSTOMER` is a foreign
key. Each area's header carries an **AreaSwitcher** linking to the other areas
the account holds, which is how you get from `/partner` to `/order` without
signing out.

### Testing a delivery end to end

Use three DIFFERENT accounts, and never weaken the conflict rules to make it
work:

- **Customer A** places the order — say `0200000021` (Ama).
- **Vendor C** accepts, prepares and marks it READY — `0200000011` for Kitchen
  One.
- **Partner B** must be neither the customer nor staff of that vendor. Adjoa
  (`0200000032`) works for a Kitchen One order placed by Ama.

If an order shows no eligible Partner, the exclusions are working. Check whether
your Partner placed the order, or staffs the vendor it came from, before
suspecting a bug.

## Timings

The seed widens three windows **for manual testing only**, because a human
switching between four browser profiles cannot beat the real ones:

| Setting               | Seeded for manual use | Production intent |
| --------------------- | --------------------- | ----------------- |
| Vendor answer window  | 30 min                | 60 s              |
| Partner search window | 30 min                | 10 min            |
| Customer-absent wait  | 60 s                  | 5 min             |
| Payment timeout       | 5 min                 | 15 min            |

Change any of them live at `/admin/pilot`. The automated tests set their own
values and ignore these. To feel the real 60-second vendor window, set it at
`/admin/pilot` before placing the order.

## The full lifecycle

Prices: **5% Campus Dash fee** on the food, **GH₵5** flat delivery.
A Jollof (GH₵35) delivered costs GH₵35.00 + GH₵1.75 + GH₵5.00 = **GH₵41.75**.

1. **Customer** `/order` → Test Kitchen One → add items → Delivery → pick a room
   (Room 101/102/204/205) → place the order. Check the fee reads GH₵3.50 on a
   single Jollof.
2. **Payment** starts automatically and settles itself after ~2 seconds. Stay on
   the order page — the page poll is what delivers the fake provider's callback.
3. **Vendor** `/vendor` → the order is in **NEW** → Accept → Preparing → Ready.
4. **Partner** `/partner` → go online → `/partner/offers` → accept the delivery.
   A Partner may hold only one at a time; use a second Partner account to see an
   offer refused.
5. **Pickup** — the Partner reads their 4-digit pickup code at
   `/partner/delivery`; the **vendor** types it in on the order. The customer's
   room and phone appear to the Partner only now.
6. **Delivery** — the customer reads their delivery code at `/orders/[id]`; the
   **Partner** types it in. Order completes; both phone numbers disappear.
7. **Admin** `/admin/money` → the order splits vendor / Partner / platform and
   sums to the total. `/admin/settlements` → create a run and pay it out.
8. **Admin, verifying the data rather than the screen** — `/admin/orders/[id]`
   shows the three state dimensions, the allocations, the event log and the
   notifications for one order. For the rows themselves, Supabase Studio
   (http://127.0.0.1:54323) or the hosted table editor: `orders`, `allocations`,
   `payments`, `payouts`, `order_events`, `notification_events`, `admin_actions`.

### Also worth walking

- **Partner approval** — Admin `/admin/partners` → Kofi Test-Applicant → the ID
  and selfie panels render placeholder images via short-lived signed URLs →
  approve or reject.
- **Pickup order** — no Partner, no delivery fee, vendor completes it directly.
- **Vendor rejection** and **letting the answer window expire**.
- **Item availability** — vendor marks an item unavailable; it disappears from
  the customer menu but placed orders keep their price.
- **Stuck payment** — restart `npm run dev` while a payment is pending. The
  fake provider's in-memory record is lost, so it hangs; after the payment
  timeout the customer can abandon it and retry, and a sweep runs every 15 min.
- **Pilot metrics** — `/admin/pilot`, which also shows whether the pg_cron
  sweeps are actually running and what they last returned.

### The failure paths worth walking by hand

Each of these is covered by an automated test as well; walking them is about
seeing what the person on the other end actually sees.

| Scenario                       | How to produce it                                                                                                             |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Vendor never answers           | Place an order, leave it. It expires after the vendor window; no charge was ever taken.                                       |
| Vendor rejects                 | Reject from the vendor board. Order closes; it cannot be revived.                                                             |
| Payment stays pending          | Restart `npm run dev` mid-payment. The fake provider's in-memory record is lost, so it hangs until the timeout or the sweep.  |
| Payment succeeds               | The default path — stay on the order page so the poll delivers the callback.                                                  |
| Second Partner races the first | Two Partner profiles, both online, both on `/partner/offers`. One wins; the other is told plainly.                            |
| Partner cancels before handoff | `/partner/delivery` → cancel. Delivery returns to SEARCHING, the pickup code rotates, the order and the vendor are untouched. |
| Old pickup code is dead        | Note the code before cancelling, then have the vendor try it. It is refused.                                                  |
| Customer absent                | Partner reports absence; the customer has the absent-wait window to respond.                                                  |
| Customer disputes              | `/orders/[id]` after delivery → dispute. Admin resolves at `/admin/orders/[id]`.                                              |
| Duplicate webhook              | Re-post the same provider event id to `/api/payments/webhook/fake`. The second is deduplicated, not charged.                  |
| Duplicate payment request      | Press pay twice. One live intent per order is a partial unique index, not a UI guard.                                         |
| Duplicate payout               | Create a settlement run twice for the same period. Refused by the payout uniqueness index.                                    |
| Wrong role                     | Sign in as a customer and open `/vendor`, `/partner` or `/admin`.                                                             |

## Resetting

```bash
npm run db:reset && npm run seed:documents
```

`npm run seed:orders [count] [DELIVERY|PICKUP]` places orders without the UI.
