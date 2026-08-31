# Partner System

One delivery at a time, carried by a verified student, with the customer's room
and phone released only when the Partner is actually holding the food.

## Becoming a Partner

Deliberately heavier than becoming a customer. Ordering needs a phone OTP and
nothing else; delivering needs:

1. a phone OTP (already done — it is the same account),
2. a photograph of a student ID,
3. a **live** face photograph, captured from the camera in the app,
4. an admin who looks at both and decides.

`partner_apply()` refuses an application missing either image, because a
half-application in the review queue wastes the one scarce resource in this
flow: a human's attention.

**The live-capture constraint is a deterrent, not a guarantee.** The face step
offers no file input anywhere in the markup, but anyone can POST to the upload
endpoint directly. The real control is that every application is reviewed by a
person — which is also why approval is manual in V1.

Documents live in a private bucket with **no storage policies at all**. An
admin sees them through a signed URL valid for two minutes. The applicant never
receives a storage path: `my_partner_application()` returns a `has_documents`
boolean and nothing else.

## Dispatch

Dispatch opens when the vendor marks food **READY** — never at order time, never
at payment. A Partner is never sent to stand at a stall waiting for cooking.

An offer shows everything needed to say yes: vendor, destination **zone**,
walking estimate, earnings, and confirmation the food is cooked. It shows
nothing about the customer, because none of that helps judge the job.

To be offered work a Partner must be approved, available, unsuspended, and
carrying nothing. All four are re-checked inside the claim itself.

## First valid acceptance wins

```sql
UPDATE orders SET partner_id = me, delivery_status = 'ASSIGNED'
 WHERE id = $1
   AND delivery_status = 'SEARCHING'
   AND partner_id IS NULL
   AND EXISTS (approved and available)
   AND NOT EXISTS (any other active delivery for me);
```

One statement checks every rule and claims the row in the same breath. Postgres
serialises the racing updates; the loser re-evaluates against the winner's
committed state and matches zero rows. Backed by the partial unique index
`orders_one_active_delivery_per_partner`, which would refuse a second claim even
if the predicate were somehow bypassed.

Tested with three Partners racing: one wins, two are told _"This delivery has
already been taken."_, and both losses are logged.

## The privacy rule

| Moment        | Partner sees                                                          |
| ------------- | --------------------------------------------------------------------- |
| Offer         | vendor, zone, walk, earnings                                          |
| ASSIGNED      | + pickup code, vendor phone                                           |
| **PICKED_UP** | + **room number, customer name, customer phone**                      |
| DELIVERED     | nothing — it disappears from the active view and never enters history |

The switch is in `partner_active_delivery()`, not in a page. The room number
does not cross the wire early whatever a screen decides to render.

The vendor sees the zone at every stage and never a phone number.

## Cancellation

Before handoff a Partner may cancel freely. No penalty in V1.

**The order does not change.** `CD-01842` stays `CD-01842`: same order, same
payment, same vendor preparation. Only the assignment is cleared and the pickup
code rotates, killing the old one instantly. The vendor sees "still looking for
a Partner" and is never asked to cancel, recreate or re-enter anything.

After handoff, cancelling is not offered — the Partner is holding food, and the
only ways out are delivering it or the absence process.

## Customer absence

Two steps, and the wait between them is enforced by the server:

1. **Report** — records a timestamp and starts a clock.
2. **Confirm** — allowed only after `customer_absent_wait_seconds` (default 300).

A Partner cannot arrive, tap "absent", and walk away with the food and the fee.

When it does close, `delivery_status` becomes `FAILED_CUSTOMER_ABSENT` and the
Partner **is paid** — they collected the order and travelled. The food order
itself stays `READY` / `PAID`: a delivery failure never destroys it.

The Partner stays attached to the order afterwards, which is why
`orders_partner_matches_delivery_state` includes `FAILED_CUSTOMER_ABSENT`.
Detaching them to satisfy a constraint would lose the only link between the
money and the person owed it — and `admin_reassign_delivery()` deliberately
refuses this state for the same reason.

## Disputes

`customer_dispute_delivery()` records a claim and changes **nothing** — not
money, not delivery state. A dispute is an assertion, and acting on assertions
automatically is how a system gets played. It surfaces at the top of the admin
board; an admin closes it with a reason, on the record.

## Earnings

A Partner sees earned, awaiting payout, and already paid. Partners are settled
weekly. There is no wallet: Campus Dash is not holding their money.
