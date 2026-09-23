# Partner System

A configurable number of deliveries at a time, carried by a verified student,
with the customer's first name, room and phone released the moment the job is
theirs and taken back the moment it is over.

## Becoming a Partner

**An upgrade to an existing account, never a second one.** Same
`auth.users.id`, same phone, same email, same student ID, same order history.
The UI says "Become a Partner" for that reason, and the form shows the student
details already on file rather than asking for them again.

`PARTNER ⇒ CUSTOMER` is a foreign key — `partner_requires_customer`, from
`partner_profiles.user_id` to `customer_profiles.user_id`, `ON DELETE RESTRICT`.
So a Partner profile cannot exist without a Customer profile beneath it, and the
Customer capability cannot be pulled out from under an approved Partner even by
a service-role statement. It is an invariant, not a convention.

What is already true by the time somebody reaches the form:

1. a verified `@acity.edu.gh` address — the identity, established at sign-in,
2. customer sign-up — full name, student ID number, level, phone, terms accepted.

What the application actually adds:

3. a photograph of the **student ID**,
4. an administrator who reads it.

`partner_apply()` therefore takes ONE argument, and what it no longer takes is
the interesting part.

**There is no face photograph.** There used to be, captured live, so a reviewer
could hold a face next to a card. It was dropped because it proved nothing the
account had not already proved: reaching this form at all requires the CUSTOMER
capability, which requires a verified `@acity.edu.gh` address. The school
established the identity; a selfie added a second, weaker check and made Campus
Dash the custodian of the most sensitive image it held.

The column `partner_profiles.face_image_path` survives, nullable and never
written. Applications made before the change still have one on file, and an
audit has to be able to see what a past decision was made on. Re-applying clears
it, and the retention purge deletes both documents on schedule.

The ID photograph may be uploaded or photographed with the camera; a card is the
same card either way, and the endpoint could not tell the difference in any
case. The control that matters is that a person reads every application.

`partner_apply()` refuses an account with no Customer capability, and refuses an
application with no student ID, because a half-application in the review queue
wastes the one scarce resource in this flow: a human's attention.

If somebody taps **Become a Partner** without the Customer capability, they are
sent through customer sign-up first and returned here — the same account, one
capability further on.

**The live-capture constraint is a deterrent, not a guarantee.** The face step
offers no file input anywhere in the markup, but anyone can POST to the upload
endpoint directly, and the server receives bytes that carry no evidence of a
camera. The real control is that every application is reviewed by a person —
which is also why approval is manual in V1. The tests assert the controls that
actually hold, not a guarantee the architecture does not provide.

Both documents live in a private bucket with **no storage policies at all**. An
admin sees them through a signed URL valid for two minutes. The applicant never
receives a storage path: `my_partner_application()` returns a boolean saying
both exist and nothing else. Both are purged together after the retention window
— they were only ever a pair, and once the comparison has been made and the
window has passed, holding either serves nobody.

**There is no separate photo-approval state.** The application is
PENDING_REVIEW, APPROVED, REJECTED or SUSPENDED, and the documents are part of
the one decision.

Approval grants the Partner capability and takes nothing away — an approved
Partner still orders lunch on the same account. A rejection likewise leaves the
Customer capability untouched.

## Dispatch

Dispatch opens **when the customer pays** — not at order time, and no longer at
READY. An offer therefore usually arrives while the food is still on the stove,
which is the point: a Partner claimed early is a Partner who is not hunted for
at the last minute, and a store whose food is going cold on the counter is the
failure the old timing produced.

Nobody is sent to stand at a counter waiting, because the offer says which it
is. Every offer carries **`food_is_ready`**, and the Partner's own job card
carries it too — "Collect from Test Kitchen One" only appears once the store has
pressed Ready; until then it reads "still preparing it". `partner_confirm_pickup()`
refuses outright while the order is not READY, and it checks that BEFORE the
code, so an eager attempt costs no attempt against the lockout.

An offer shows everything else needed to say yes: store, the store's daily queue
number, destination **zone**, walking estimate and earnings. It shows nothing
about the customer, because none of that helps judge the job — and everything
about them arrives the instant the job is theirs.

To be offered work a Partner must be approved, available, unsuspended, and
**below the capacity limit**. All four are re-checked inside the claim itself.

An eligible, available Partner is also texted when a delivery appears. The
message says only that one exists and links to the dashboard: no customer, no
destination, no amount owed to a named person. Everything real is behind their
own session. The recipient list is `partners_to_notify_of_offer()`, which
re-derives eligibility from the same rules the offer list uses, so nobody is
texted about work they would then be refused.

## Capacity: a setting, enforced by an index

One at a time was the safe first answer. It is also the answer that makes a
Partner walk back to the same block twice. Two is the default — but how many a
Partner may carry is a pilot question, so it is
`pricing_config.max_active_deliveries_per_partner`, editable at
`/admin/pilot` between 1 and 10, audited in `admin_actions` like every other
operational change.

**The setting decides how many slots exist. The index decides that two claims
never get the same one.** `partner_accept_delivery()` reads the configured
maximum on every attempt, so a change takes effect on the next acceptance rather
than the next deploy — but reading a number out of a table is not an atomicity
primitive and is not asked to be one.

"At most one" could be a unique index on `partner_id`. **"At most N" cannot.**
So an active delivery holds a numbered SLOT, `orders.partner_slot`, and the slot
is what is unique:

```
orders_partner_active_slot_unique
  ON orders (partner_id, partner_slot)
  WHERE partner_id IS NOT NULL
    AND partner_slot IS NOT NULL
    AND delivery_status IN ('ASSIGNED', 'PICKED_UP')
```

**Lowering the maximum never takes an order off anybody.** A Partner carrying
three when it drops to two keeps all three: the count check refuses only NEW
acceptances, and the slot index ignores finished deliveries. They come back
under the limit by finishing what they have.

`partner_capacity()` tells the dashboard how many slots are free. It is a
display fact — the claim re-derives everything for itself — and it exists so a
Partner is not offered a button that will be refused.

## First valid acceptance wins

```sql
UPDATE orders SET partner_id = me, partner_slot = <lowest free>, delivery_status = 'ASSIGNED'
 WHERE id = $1
   AND delivery_status = 'SEARCHING'
   AND partner_id IS NULL
   AND EXISTS (approved and available)
   AND (SELECT count(*) FROM my active deliveries) < 2;
```

One statement checks every rule and claims the row in the same breath. Postgres
serialises the racing updates; the loser re-evaluates against the winner's
committed state and matches zero rows.

The count in the WHERE clause is **belt**; the slot index is **braces**. The
count is evaluated against a snapshot, so under READ COMMITTED two transactions
can both see one active delivery — a Partner double-tapping two offers. Both
would compute the same free slot, and the index refuses the second. That
violation is caught and turned into an ordinary "you already have two active
deliveries", because to the Partner it is not an error, it is an answer.

Tested three ways: three Partners racing for one delivery (one wins, two are
told _"This delivery has already been taken."_, both losses logged); one Partner
racing themselves for three deliveries (exactly two land); and a direct
service-role UPDATE bypassing every function (the index refuses either slot).

## The privacy rule

| Moment                     | Partner sees                                                         |
| -------------------------- | -------------------------------------------------------------------- |
| Offer (unassigned)         | vendor, **zone**, walk, earnings. Nothing about a person             |
| **ASSIGNED** and PICKED_UP | + **customer FIRST name, room number, customer phone**, vendor phone |
| DELIVERED                  | nothing. It leaves the active view and never enters history          |

**A first name, and it is the largest thing on the card.** It is what a Partner
says when somebody opens the door, so it sits above the room number rather than
under it. `partner_active_delivery()` returns `customer_first_name` from
`given_name()`; a surname is never sent, because it helps nobody find a door.

**The window opens at ASSIGNMENT, not at handoff.** A Partner who cannot find a
room needs to ring before they are holding food that is going cold, not after.
The dashboard shows the number with a `tel:` **Call customer** action.

It is authorised in two independent places, and neither is a screen:

- the RLS policy `users_read_customer_during_active_delivery`, which admits the
  customer's row only for `partner_id = auth.uid()` and only while the delivery
  is ASSIGNED or PICKED_UP;
- `partner_active_delivery()`, which selects those columns under the same
  condition.

An unassigned Partner gets nothing from either. A completed delivery closes both
— `partner_delivery_history()` has never carried a phone number, and the RLS
policy stops matching. If support needs the number afterwards that is an admin
looking at an admin screen, which is a different authorisation with an audit
trail behind it.

**Neither the number nor the name is ever in an SMS.** The number was, once, in
the PARTNER_PICKED_UP message. An SMS is forwardable, screenshottable and
permanent, and it outlives the delivery it was sent for; the dashboard's version
expires when the authorisation does. The same reasoning keeps the customer's
name out of PARTNER_ASSIGNED.

The customer's side of this is symmetrical and no wider: they are told the
Partner's FIRST name — "Kwame has accepted your order" — from assignment until
completion, and nothing afterwards.

The offer list shows a zone and a floor (`Hostel A`, `C Floor`), never a room. Every available
Partner sees that list, and a student's room number is not something to
broadcast to a pool of people who have not been given the job yet.

The vendor sees the zone at every stage and never a phone number.

## The handoff, in both directions

Two codes, four digits each, one rule: **the person who holds the secret is
never the person who performs the act.**

| Code     | Held by      | Read out by  | Typed in by | Function                      |
| -------- | ------------ | ------------ | ----------- | ----------------------------- |
| Pickup   | the STORE    | the store    | the PARTNER | `partner_confirm_pickup()`    |
| Delivery | the CUSTOMER | the customer | the PARTNER | `partner_complete_delivery()` |

A customer collecting their own order is the same shape with the Partner
removed: the store holds the code, the CUSTOMER types it into
`customer_complete_pickup()`. One function returns a handoff code —
`vendor_handoff_code()` — and it is behind `is_vendor_staff`.

Four digits is ten thousand guesses, which is minutes of scripted requests — so
each side counts its consecutive failures and locks out for
`pricing_config.code_lockout_seconds` after `code_attempt_limit` of them. The
lockout refuses the CORRECT code too, because one that let it through would tell
an attacker they had finally guessed right. See `check_handoff_code()`, and
`docs/SECURITY.md` for who can spend an attempt at all.

The pickup code used to travel the other way — the Partner read it aloud and the
vendor typed it in. Which meant the person confirming the handoff was the person
not carrying anything away, and a vendor who mistyped blocked a Partner standing
in front of them. Reversing it kept the proof identical and moved the act to the
person whose next step depends on it.

There is **no function that returns a handoff code to a Partner**. The claim
does not hand one back either. That asymmetry is the whole mechanism.

A MEAL SCAN ORDER IS NO DIFFERENT. It used to have no handover to prove — the
Partner reported the redemption themselves — but the store checks the scan on
its own board now, hands the food over and reads out the same four digits. One
collection path, not two. See `docs/SCAN.md`.

## Cancellation

Before handoff a Partner may cancel freely. No penalty in V1.

**The order does not change.** Order 007 stays order 007: same order, same
payment, same preparation. Only the assignment is cleared — the slot is released
too, so the Partner is free to take other work — and the handoff code rotates,
killing the old one instantly. The order goes straight back into the pool, where
another Partner can take it; the store sees "waiting for a Partner" and is never
asked to cancel, recreate or re-enter anything.

**No administrator is involved.** A Partner who cannot do a job is ordinary, and
routing that through a person would leave somebody's paid-for dinner waiting on
a support queue.

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

## Ratings

After a delivery completes, the customer is offered five stars and an optional
comment. One rating per delivery, and the ORDER is the primary key of
`partner_ratings` — so a second tap cannot become a second row, and there is no
counter to keep in step.

**The Partner is not a parameter.** `customer_rate_partner()` reads them off the
order, so nothing a hand-built request contains can aim a rating at somebody
else.

**A Partner sees their average, never the individual rows.** With two deliveries
an hour, one row plus a timestamp names the customer who left it, and a Partner
who can identify a complainant is a Partner somebody is afraid to rate honestly.
The RLS policies admit the customer who wrote it and an administrator; a Partner
reads `my_partner_rating()`, which is an aggregate. Administrators see
everything at `/admin/community`, filtered to one and two stars, because that is
the list that needs a conversation rather than a metric.

## Earnings

**GH₵5 per completed delivery, paid weekly once the balance reaches GH₵20.**
The dashboard leads with one number — what is available now — and a bar towards
the payout amount. Below it: orders completed, total earned, anything already on
its way, and what has been paid.

There is no wallet. `allocations` is the ledger, one row per completed delivery,
and "available" is a sum over it rather than a stored balance that could drift.

**Completing a delivery adds GH₵5 to that ledger, and nothing else happens.**
The dashboard reflects it immediately and the SMS says "added to your earnings
balance" — never "sent" or "paid". A Partner who finishes a run at 8pm and then
watches a MoMo balance that is not going to move has been lied to by a word.

A balance under GH₵20 **carries forward**; it is never lost and never reset. See
`docs/MONEY.md` for how the run guarantees that.

**The copy names no payment provider.** A Partner reads a normal weekly payout
policy, because that is what it is. Campus Dash's arrangements with Paystack are
Campus Dash's problem, and a Partner who has walked across campus four times
should not be handed a technical reason they cannot be paid.

When a payout completes they are texted. The message names an amount and a link
and deliberately **not a rail**: an administrator may settle by bank transfer,
by mobile money or in cash, and naming the wrong one is worse than naming none.
The dashboard is the record.
