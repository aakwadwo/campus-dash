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

| Shown                                             | Withheld                           |
| ------------------------------------------------- | ---------------------------------- |
| The daily queue number, items, quantities         | The customer's phone number        |
| Snapshotted prices and the total                  | The destination **room**           |
| Collection, or delivery + **zone**                | The delivery code                  |
| Payment status                                    | Any other store's orders           |
| Order age                                         | Which Partner, beyond a first name |
| The handoff code, once somebody is due to collect |                                    |

The destination zone (`Hostel Block A`) is enough for a store to picture the
job. The room is the Partner's business, not theirs. A collecting customer's
FIRST name is shown, because the store has to call it out; a delivery is met by
a Partner, so the customer's name is not the store's business at all.

**The order number is a daily queue number** — 001, 002, 003, restarting every
morning and counted per store. `orders.order_number` (`CD-01043`) is still
underneath as the internal reference, and is never what anybody is asked to read
out.

## The three groups

Server-decided, via `vendor_order_bucket()`, so every screen agrees:

- **NEW** — paid, and still to be made. The only group that raises an alert.
- **READY** — made, waiting for a Partner or a customer to collect.
- **CLOSED** — completed or cancelled. Capped at 20 so a busy store does not
  scroll through last week.

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

## Today's menu

A store does not create or price items — an administrator does, so a catalogue
cannot be rewritten mid-service and a price cannot move under an order somebody
is halfway through placing. What a store owns is **whether something is
available right now**, which is the thing that changes forty times a day and
which nobody should have to email about.

A sold-out item stays on the storefront, marked sold out. A dish that vanishes
reads as a store that stopped selling it; a dish marked sold out reads as a
store that is busy. `submit_order_for()` refuses it either way.

**Reopening the store clears every sold-out mark.** Running out of jollof is a
fact about today's service, not a standing property of the dish, and a vendor
who has to untick fourteen items before they can sell anything will stop
bothering. The reset is on the CLOSED → OPEN transition, so pressing Open again
out of habit while already open leaves a mark somebody set a minute ago alone.

A vendor **can** open and close their own store. Closing stops new orders and
leaves orders already in flight completely alone — the customer still gets fed.

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

- **Order history beyond today**, search, printing, and per-item availability
  from the vendor screen. None of these are needed to get food out.
- **Multiple stores per account.** See above: a picker for a case nobody has.

`submit_order_for()` places an order as a given customer and is never granted to
a client role; `scripts/seed-orders.mjs` is its only caller.
