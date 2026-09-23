# Vendor Module

One job: a real vendor, on a phone next to a hot plate, takes an order from
arrival to READY without having to understand anything else about the system.

## A vendor is an identity that owns a business

`vendors.owner_user_id` — one column, one foreign key, unique. That is the whole
model, and it replaced a `vendor_users` join table that expressed a staffing
arrangement nobody in the pilot has: nobody staffs a campus stall in shifts.
What the join table cost was the thing that mattered — a vendor could not sign
up. Recruitment was a conversation, a phone call to an administrator, and a
hand-typed row.

**One account, one store.** Not a limitation of the model, a deliberate
narrowing of it: multiple stores per account would put a store picker on every
vendor screen for a pilot in which nobody runs two.

`owner_user_id` is NULLABLE, and that is deliberate rather than sloppy. A scan
restaurant is listed by Campus Dash so students can have a prepaid meal fetched
from it; the restaurant operates no dashboard, has signed up for nothing, and
must not be invented an account. A vendor with no owner is a **catalogue
entry**: orderable, never operable. `my_vendor_ids()` matches no row for it, so
there is no path by which a NULL owner becomes an accidental grant. An
administrator creates one with `admin_create_vendor()`.

## Signing up

**The form is the first screen. Not the phone number, and not the code.**
Asking a stall owner to prove a number before telling them what they are signing
up for asks for a commitment before the offer.

```
applicant name · store name · student? · what you sell · category · phone · terms
        │
   SMS code to that number
        │
   vendor_signup()  →  PENDING_APPROVAL
        │
   an administrator approves or rejects, with a reason
```

**No email is asked for, here or ever.** The phone number IS the credential, and
`vendor_signup()` reads it from the caller's own `users` row rather than taking
it as a parameter — so the credential and the store's contact number cannot
disagree, and nobody can register a store against somebody else's number.

A PENDING or REJECTED vendor can sign in and see exactly that at
`/vendor/application`, and nothing operational. A rejection carries a reason and
that reason is shown to the applicant, not just written to the audit log: a
rejection somebody cannot read is a dead end rather than a decision. Calling
`vendor_signup()` again from a REJECTED state is a **resubmission** — same store,
same identity, corrected facts, back in the queue with the old decision cleared.

**Approval does not open the store.** It grants the capability; opening for
orders is the vendor's own decision, made when they are actually standing behind
the counter. The owner is texted a link to their dashboard.

### The other door: an administrator creates the account

A store recruited in person will not go home and fill in a form. So
`admin_create_vendor_account()` takes the same facts at the counter and makes
the same application: a store with an `owner_user_id`, `PENDING_APPROVAL`, with
`submitted_at` set. It lands in the **existing** review queue, is approved by
the **existing** `admin_review_vendor()`, and the owner gets the **existing**
welcome SMS. Creating a store and approving one stay two decisions and two audit
rows; an administrator does not get to be the record of their own approval.

The identity is not made in SQL. `auth.users` belongs to GoTrue, so
`lib/admin/createVendorAccount()` provisions it through the auth admin API with
the number confirmed — an administrator standing in front of the owner is the
verification — and hands the id to the function. **A number Campus Dash already
knows is reused, never duplicated**: that is the whole lesson of the phone
collision that once presented as `500 Error confirming user`. If the store
cannot then be created, an identity made for it is removed again, because an
account that can sign in and owns nothing is the orphan this is avoiding.

### Deleting a store

`admin_delete_vendor()` removes a store that **never traded**, with its menu,
its photographs, its daily queue counter and its payout destination — and the
owner's identity too, but only if the store was the only thing that identity
held. Somebody who also buys lunch keeps their account and simply stops having a
store.

It **refuses** a store with orders against it, and says how many. Those orders
carry payments and allocations, and those are what reconcile the bank account;
the control for a store that has traded is SUSPENSION, which takes it off the
marketplace and keeps the history. A genuine pilot reset is
`scripts/purge-test-accounts`, which runs as the database owner and is
deliberately not reachable from a browser.

Storage is not deleted in SQL — `storage.objects` refuses a SQL delete by design
— so the function returns the object paths it saw and `lib/admin` removes them
through the Storage API after the transaction commits.

## The store itself

A vendor owns their own facts and does not have to email anybody to fix a typo
in their shop name: `vendor_update_profile()` covers the name, the description,
the category and where they are. `vendor_add_image()` / `vendor_delete_image()`
cover the storefront gallery — **one gallery, no separate logo**, because a logo
is a second thing to design, upload, crop and moderate and the pilot's stalls do
not have one.

Storefront photographs live in a **public** `vendor-images` bucket. That is the
honest shape of the thing: an unauthenticated visitor browsing the marketplace
has to see them, and signing a URL per photo per page load would be real cost
for no secret. What stays locked down is WRITING — the bucket has no storage
policies at all, so every object in it went through a server that checked who
was asking.

Categories are admin-managed rows (`vendor_categories`), not an enum: the person
who knows a new kind of stall has opened is an operator with a browser, not an
engineer with a branch. Disabling one hides it from the sign-up form and the
customer filter and touches no vendor row — the stalls already in it keep
trading, and every historical order keeps the category it was placed under.

## What a vendor does

```
A PAID order arrives  ─── SMS + in-app alert
        │
        │   (nothing to accept: the customer already paid for it)
        ▼
    MAKE THE FOOD
        │
 READY FOR PICKUP ────▶ a four-digit code appears on the order
        │
        └──▶ read it out to whoever collects — a Partner, or the customer.
             They type it into their own app. Only then hand the food over.
```

That is the whole vendor mental model: **make it, press Ready, read out a
number.** There is no accept, no reject, no 60-second countdown and no separate
"start preparing" — a store never sees an order that has not been paid for, so
there is nothing left to decide. Partner matching, payment collection,
allocation and settlement all happen without them.

The button says **Ready for pickup**, and deliberately not _Done_. Done would be
a lie: nobody has the food yet, and the handoff still has to be proved.

## What the vendor sees, and what they do not

The board and detail come from `vendor_order_board()` and
`vendor_order_detail()`, which decide exposure in the **database**. A page that
merely omitted a column would still have sent it over the wire.

| Shown                                             | Withheld                             |
| ------------------------------------------------- | ------------------------------------ |
| The daily queue number, items, quantities         | The customer's phone number          |
| Snapshotted item prices                           | The destination **room**             |
| **Their own amount** (`vendor_amount_pesewas`)    | The customer's total                 |
| Collection, or delivery + **zone**                | The service fee and the delivery fee |
| Payment status                                    | The delivery code                    |
| Order age                                         | Any other store's orders             |
| The handoff code, once somebody is due to collect | Which Partner, beyond a first name   |

**A vendor sees only their own cut.** `vendor_amount_pesewas` is the food
subtotal, which is exactly the VENDOR allocation and the amount the Paystack
split routes to the store. Neither read function returns `total_pesewas`,
`service_fee_pesewas` or `delivery_fee_pesewas` any more: the service fee is
Campus Dash's, the delivery fee is the Partner's, and the board used to hand
both to a client component under "Customer paid". See migration
`20260930000001_vendor_sees_only_their_amount.sql`.

**A vendor has no direct read of `orders`, `order_events` or `order_items`.**
Migration `20260930000002_vendor_reads_only_through_rpcs.sql` dropped
`orders_read_vendor` and the vendor branches of `order_events_read` (whose
`details` record the customer's total and the delivery fee) and
`order_items_read`. A store's view of its orders is exactly what the vendor
functions return: `vendor_order_board`, `vendor_order_detail`,
`vendor_pending_count`, `vendor_active_count`, `vendor_handoff_code`,
`vendor_daily_sales` and `vendor_orders_on_day`, each re-checking
`is_vendor_staff()`. The only money a vendor reads directly is its own: VENDOR
allocations and its payouts. Customers, assigned Partners and administrators keep
their policies unchanged.

The destination is not the store's business at all, not even the block. What a
store DOES see is the customer's **Order information** on the order detail
(`vendor_order_detail().order_information`) — "no pepper", "extra napkins". It
is written with the order, so it is there the moment the paid order reaches the
board. The customer's **Additional information** is for their Partner and is
never returned to a store. A collecting customer's
FIRST name is shown, because the store has to call it out; a delivery is met by
a Partner, so the customer's name is not the store's business at all.

**The order number is a daily queue number** — 001, 002, 003, restarting every
morning and counted per store. `orders.order_number` (`CD-01043`) is still
underneath as the internal reference, and is never what anybody is asked to read
out.

## The dashboard

The store's home is `/vendor/<id>`. It answers three questions, in order:

1. **How is today going?** Today's orders and Today's sales, from
   `vendor_daily_sales()` — the sum of this store's live VENDOR allocations,
   grouped by `orders.order_day`, the same day the queue number restarts on.
   Under them, when anything is on its way, **Pending payout** and **Next
   payout** ("Monday morning"). Paystack, not Campus Dash, settles a store with
   a subaccount: its share is split off each charge and paid to its mobile
   money on the next Ghana working day. `vendor_payout_days()` reads the split
   money by the Ghana day it was paid, and `lib/settlement/schedule.js` turns
   each day into the working day it lands (weekends and Ghana public holidays
   skipped — `lib/settlement/ghana-holidays.js`, whose DECLARED list needs the
   Eid dates, Shaqq Day and any moved holiday added each year; until they are,
   the screen can name a morning one day early). The schedule is Paystack's
   published one for GHS (support.paystack.com/en/articles/2123586, checked
   September 2026), and relies on the subaccount's `settlement_schedule` being
   left at its default, `auto`, which `ensureSubaccount()` does. Money owed through the ledger instead (no subaccount at the time)
   is not shown on this screen: it is not on Paystack's schedule, and no date is
   promised for it. Nothing here writes a settlement record.
2. **What needs me?** The NEW and READY groups below.
3. **What just happened?** The last five finished orders, then **History**.

Navigation is four named destinations — Orders, History, Menu, Store — as a
bottom bar on a phone and tabs from `sm` up. Sign-out lives on the Store tab,
because a vendor-only account is redirected out of `/account`.

## History

`/vendor/history` lists the last 30 days: orders and sales per day, Today first
even at zero. A day opens `/vendor/history/<YYYY-MM-DD>`, the orders behind that
row from `vendor_orders_on_day()`, each linking to its detail. An order counts as
a sale while it is `PAID` and has a live VENDOR allocation. `REFUND_PENDING` and
`REFUNDED` orders are listed and labelled, and left out of the total, even where
a split left the allocation `SETTLED`; the ledger itself is untouched. A day whose
only orders were refunded is still listed, at zero, so they stay reachable. Deliberately not an analytics screen: no
charts, ranges or averages.

## The three groups

Server-decided, via `vendor_order_bucket()`, so every screen agrees:

- **NEW** — paid, and still to be made. The only group that raises an alert.
- **READY** — made, waiting for a Partner or a customer to collect.
- **CLOSED** — completed or cancelled. The dashboard asks for the last five;
  the full record is History.

There used to be a fourth, between accepting an order and starting it. It only
existed because a store had to answer a doorbell.

**An unpaid order is not on the board at all.** `vendor_order_board()` filters
on `payment_status`, so a basket abandoned at a checkout is never a ticket.

Live work sorts **oldest first**: the order waiting longest leads.

## The new-order alert

Three signals, no push infrastructure:

1. **SMS** through the existing `SmsProvider` — the same seam every other
   notification uses.
2. **In-app banner** plus a count in the browser tab title.
3. **A short tone** when the pending count goes _up_, because a phone on a
   counter is not being watched.

The page polls `vendor_pending_count()` every 8 seconds. That function checks
`is_vendor_staff()` itself, so probing another vendor's id returns 0 rather than
a number that leaks how busy a competitor is.

## Things a vendor cannot do — and why they cannot

Not hidden buttons. There is no grant under which any of these could succeed:

| Cannot                                | Enforced by                                                             |
| ------------------------------------- | ----------------------------------------------------------------------- |
| Mark an order PAID                    | No UPDATE grant on `orders`; `confirm_payment` not granted to clients   |
| Change the price of a submitted order | No UPDATE grant on `orders` or `order_items`                            |
| Change what was ordered               | No INSERT/UPDATE/DELETE grant on `order_items`                          |
| Complete a delivery                   | `partner_complete_delivery` requires being the assigned Partner         |
| Confirm a Partner handoff             | `partner_confirm_pickup` requires being the assigned Partner            |
| Assign a Partner                      | No UPDATE grant; `partner_accept_delivery` requires an approved Partner |
| Read a **delivery** code              | `order_secrets` has no policy and no grant for anyone                   |
| Touch another vendor's order          | Every function re-checks `is_vendor_staff()`                            |
| Approve their own store               | `admin_review_vendor` requires an admin                                 |
| Change their own vendor status        | `admin_set_vendor_status` requires an admin                             |

## The one secret a store DOES hold

The **handoff code**. `vendor_handoff_code()` returns it, and only while
somebody is actually due to collect: a Partner assigned to the order, or a
customer whose collection is made.

ONE CODE, ONE DIRECTION, BOTH HANDOFFS. The store reads it out; whoever is
taking the food types it into their own app — `partner_confirm_pickup()` for a
delivery, `customer_complete_pickup()` for a collection. The rule underneath is
unchanged and is the only one that matters: **the person who holds the secret is
never the person who performs the act.** The person acting is the one walking
away with somebody's dinner, which is the person whose next step depends on it.

There is **no function that shows the code to the person collecting**, on either
side. Adding one would put the secret and the act in the same hand and the code
would prove nothing.

The collection handoff used to run the other way — customer holds, vendor types.
That put the confirming keystroke on the person who was not carrying anything
away, and a mistyped digit blocked a queue at a counter.

## The catalogue, and today's menu

**Build your catalogue once. Turn things on when you are serving them.**

A store owns two different lists, and keeping them apart is what stopped menu
management being a chore:

|                     |                                                                                        |
| ------------------- | -------------------------------------------------------------------------------------- |
| **The catalogue**   | everything this store sells, ever. Added once, priced once, never removed by a switch. |
| **The active menu** | which of those it is serving right now — `menu_items.is_active`.                       |

A stall sells eggs in the morning, plantain at eleven and jollof at one. Before
`is_active` the only way to stop offering something was to take it off the menu
and the only way to offer it again was to put it back, item by item, several
times a day. Vendors who found that tedious solved it by deleting and re-adding
dishes, which is how a store ends up unable to delete anything: every name has
an order behind it.

A new item joins the **catalogue**, switched off. Adding a dish is not the same
decision as starting to sell it, and a default of ON would open a closed store
from the menu screen.

### OFF is not SOLD OUT

Three states, and a customer experiences each of them differently:

| State          | The customer                         |
| -------------- | ------------------------------------ |
| OFF            | does not see it at all               |
| ON + SOLD OUT  | sees it, marked, and cannot order it |
| ON + AVAILABLE | sees it and can order it             |

A dish that vanishes reads as a store that stopped selling it; a dish marked
sold out reads as a store that is busy. `price_order()`, `price_scan_order()`
and `submit_order_for()` refuse all three of the unorderable cases — the item
being off, the item being sold out, and the store being closed — at the server
boundary, so a browser holding a page from twenty minutes ago cannot order from
it. `menu_items_read_public` is what makes OFF invisible, so no screen has to
remember the filter.

`unavailable_reason` therefore means exactly one thing now: `SOLD_OUT`. The old
`WITHDRAWN` reason was "off the menu until I put it back", which is `is_active`
and is no longer a kind of unavailability.

### Open and closed follow the menu

One invariant, maintained by the database rather than hoped for:

> a store is OPEN if and only if at least one of its items is ON

which reads, in the five transitions a vendor can perform:

| They do this             | And                                              |
| ------------------------ | ------------------------------------------------ |
| close the store          | every active item goes OFF. The catalogue stays. |
| turn one of several OFF  | the rest stay ON and the store stays open.       |
| turn the LAST one OFF    | the store closes itself.                         |
| turn one ON while closed | the store opens itself.                          |
| open with nothing ON     | **refused**, and told to turn an item on.        |

An open store showing an empty menu is a customer walking across campus to a
counter that has nothing for them, so it is not a state the database will hold.
Nor is the mirror of it: a closed store cannot expose an orderable menu, because
closing is what emptied it.

Every one of those transitions takes the vendor row with `SELECT … FOR UPDATE`
before it reads the count — `vendor_apply_menu_state()` is the shared tail — so
a phone and a tablet on one counter serialise instead of racing to leave the
store open with nothing on it. Reading a number from a table is not an atomicity
primitive.

**A CLOSED → OPEN transition clears every sold-out mark**, wherever it comes
from: pressing Open, or turning on the first item of the day. Running out of
jollof is a fact about today's service, not a standing property of the dish, and
a vendor who has to untick fourteen items before they can sell anything will
stop bothering. The reset is on the transition, so turning a fourth item on
while already open leaves a mark somebody set a minute ago alone.

Closing stops new orders and leaves orders already in flight completely alone —
the customer still gets fed.

## One account, two devices

There is one owner per store, so the realistic race is a phone and a tablet on
the same counter rather than two colleagues. It is the same race and the same
guarantee: when both tap ACCEPT at the same moment, one wins and the other is
told plainly that somebody got there first — not a state machine error.
Getting that message right mattered: the failure branch re-reads the current
state, because the value captured before the race describes a world that no
longer exists.

Losing the store — an admin suspending it, or ownership being cleared — cuts the
board off immediately, mid-shift.

## Deliberately not built

- **Order history beyond today**, printing, and per-item photographs from the
  vendor screen. None of these are needed to get food out.
- **Multiple stores per account.** See above: a picker for a case nobody has.

`submit_order_for()` places an order as a given customer and is never granted to
a client role; `scripts/seed-orders.mjs` is its only caller.
