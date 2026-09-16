# Customer Ordering

One job: a student on a phone picks food from an approved stall and pays for it.

## Browsing is open; ordering is a capability

Anyone can look. `storefront_vendors()`, `storefront_vendor()`,
`active_vendor_categories()` and `menu_items` are all reachable by `anon`, so
`/order` runs the same queries signed out as it does signed in — categories,
photographs, menus, open/closed state and all. Somebody can build a basket
before they have an account, and the sign-up prompt carries a `next` that brings
them back to the same stall with the basket still in the page.

Placing an order needs the **CUSTOMER capability**, which is a
`customer_profiles` row, which is acquired by completing sign-up:

- first and last name
- school email — it must end **exactly** `@acity.edu.gh` — and a code sent to it
- **student or staff**, and for a student the year they expect to graduate
- gender, which is optional
- a phone number
- acceptance of the current customer terms

**Staff are full customers.** They order, and they may become Partners. The
distinction changes what sign-up asks and nothing about what the account may
then do.

**A graduation year rather than a level.** `level` — 100, 200, 300, 400 — was
wrong for three of the four years it described: nobody comes back in September
to move themselves up, so an account created in first year claimed to be a first
year for ever. The year somebody expects to finish is the same fact stated so
that it stays true for as long as they are here. The column survives, nullable
and unwritten, so an older row still says what it said.

`complete_customer_onboarding()` writes all of it in one transaction, including
the terms acceptance — a capability granted before the agreement it depends on
is a gate that opens itself. There is no admin review: completing the form **is**
the grant.

**The address is not a parameter.** It is read inside the database from
`auth.users`, where GoTrue put it after the verification code was accepted, so
"verified" means verified rather than typed. A caller-supplied address would let
anyone claim any student's.

**The phone number is a profile field, not a credential.** It exists so a
Partner standing outside a door can ring. It is unique — one number must not
describe two people — but it is never how a customer signs in.

**There is no ID photograph, and no ID NUMBER either.** Both used to be asked
for and neither was ever checked against anything: no review consumes them for
an ordinary customer, so collecting them was cost without a control. The
photograph moved to the Partner application, which is the one review that
genuinely reads a card. The number went away entirely — a verified
`@acity.edu.gh` address is the school's own record of who somebody is, and a
number typed into a box was a second copy of that with nothing behind it.

`customer_profiles.student_id_number` survives, NULLABLE and unique-when-present,
because the accounts created before the change still carry one and a past review
should stay auditable against what it was made on. Nothing new writes it.

It is not a new account. The identity already exists — an address was verified
to get this far — so sign-up only ever adds a capability to the `auth.users.id`
already in the session. An administrator or a vendor account that has not done
it genuinely cannot order, because `submit_order_for()` asserts `is_customer()`
server-side rather than trusting a screen.

An administrator CAN hold it, and the pilot's does: their sign-in address is a
school one, so `Admin + Customer` is reachable rather than theoretical. A vendor
account signs in by phone and has no address at all, so it would have to acquire
one first.

## The flow, and why it is in this order

```
pick items  →  choose collection or delivery  →  see the FINAL price  →  PAY
                                                                          │
                                                                          ▼
                                              the store receives a PAID order
                                                                          │
                                              delivery: a Partner is sought
                                                        WHILE it is being made
                                                                          ▼
                                                     READY  →  handoff  →  done
```

**Everything is decided at the checkout, and the store only ever sees an order
somebody has paid for.** There is no acceptance step and no 60-second window.
A store answering a doorbell was the most fragile part of the product: it put a
countdown on a phone next to a hot plate, it produced orders that expired for
nobody's fault, and it made the customer wait to find out what their lunch was
going to cost.

`submit_order()` therefore takes the fulfilment and the destination, prices the
whole thing — food, the 6.95% service fee, and the GH₵5 if a Partner is bringing
it — and creates the order ACCEPTED, which from here means "priced and payable".
`confirm_payment()` is what moves it to PREPARING and, for a delivery, what
opens the Partner search.

`order_status` and `payment_status` stay separate fields for the same reason
they always were: an order can be priced and unpaid, or paid and not yet cooked,
and neither implies the other.

**The choice can still be changed, while nothing has been paid.**
`customer_choose_fulfilment()` recomputes the total from the order's own price
snapshot plus the delivery fee read from `pricing_config` now — the caller sends
no amount and there is no parameter for one.

**An order nobody pays for is swept.** `accept_deadline_at` is the pay-by
deadline, and `expire_stale_orders()` cancels what is past it. Nothing is ever
charged.

**One order is exactly one vendor.** There is no multi-vendor cart and no way to
express one: `orders.vendor_id` is a single column.

## Nothing the client sends is trusted

The browser sends **menu item ids and quantities**. That is all it sends that
matters, and it is all the server reads.

`price_order()` takes those ids, looks up the current prices itself, applies the
fees from `pricing_config`, and returns the total. A basket that arrived
carrying `unit_price_pesewas: 1` produces exactly the same order as one that
carried nothing — there is no code path that looks at the field.

The same function backs `quote_order()`, which is what the review screen
displays. One implementation, so the number shown and the number charged cannot
disagree.

## Price snapshots

`order_items` stores the item's **name and unit price as they were at submit
time**. A vendor who reprices tomorrow does not change what anyone already
agreed to pay, and a vendor who disables an item does not break an order that
already contains it. Both are tested.

## What the customer sees

`customer_order_detail()` returns their order, the vendor's **name**, and what
they are being charged. It does not return the vendor's id or phone, another
customer's anything, or the contents of `order_secrets`.

The screen shows a single **stage**, computed in the database from all three
state dimensions together:

| Stage                            | Means                                                    |
| -------------------------------- | -------------------------------------------------------- |
| `PAYMENT_REQUIRED`               | Priced. Pay now and the store starts.                    |
| `PAYMENT_PROCESSING`             | Charge in flight. Do not pay again.                      |
| `PAYMENT_FAILED`                 | Nothing taken. Retry creates a new attempt.              |
| `PREPARING`                      | Paid, and being made.                                    |
| `PREPARING_PARTNER_ASSIGNED`     | Being made, and somebody has already agreed to bring it. |
| `READY`                          | On the counter. The store will give you a code.          |
| `SEARCHING_PARTNER`              | Made, and looking for somebody to bring it.              |
| `PARTNER_ASSIGNED`               | Your Partner is collecting it now.                       |
| `ON_THE_WAY`                     | They have it, and are coming to you.                     |
| `NO_PARTNER` / `CUSTOMER_ABSENT` | Something went wrong with the delivery only.             |
| `COMPLETED` / `CANCELLED`        | Over, with the reason, and no surprise charge.           |

`AWAITING_VENDOR`, `REJECTED` and `EXPIRED` are historical: they describe orders
placed before a store stopped answering doorbells. Nothing new reaches them, and
the wording survives so an old order still reads as a sentence.

`PREPARING_PARTNER_ASSIGNED` is the one the new shape adds, and it is the
update people actually want: "Kwame has accepted your order", arriving while the
food is still on the stove.

Deriving this once in SQL means no screen has to reason about how the three
dimensions interact — which is exactly where a UI gets it wrong.

The order screen draws these as a **timeline**: steps that have happened, the
one happening now, and the ones still to come. That is the whole tracking
experience, and there is deliberately **no map**. Campus Dash has no GPS and no
live position for anybody; drawing a map we cannot populate would be inventing a
capability, and a stale pin is worse than an honest list of steps.

## Who is bringing it

From assignment until the delivery ends, the order screen names the Partner by
their **first name** and offers a `tel:` link. "Kwame is bringing your order" is
what a person says; a surname adds nothing to finding somebody at your door and
is theirs, not ours to hand out. Both stop the moment the delivery completes —
`customer_order_detail()` returns null for each outside that window.

## The two codes a customer touches

Both are **four digits**, generated server-side.

**Delivery code.** Minted when a Partner is assigned, shown on the order screen
from that moment. The customer reads it out on arrival and the Partner types it
in. A Partner cannot declare a delivery done without it.

**Collection code.** A different code, for an order the customer is picking up
themselves. Minted when they choose PICKUP, shown once the order is paid and in
the kitchen. They show it at the counter and the VENDOR types it in.

In both cases the person who holds the secret is not the person who performs the
act, which is the only reason either code proves anything. Repeated wrong
answers lock the handoff out for a few minutes; see `docs/SECURITY.md`.

## Rating the Partner

The instant a delivery completes, the order screen offers five stars and an
optional comment. One prompt, one rating, dismissible — `can_rate_partner` comes
from the database and goes false the moment a rating exists, and the order is the
primary key of `partner_ratings`, so a second tap cannot become a second row.

The Partner being rated is read off the order rather than sent, so there is
nothing here for a modified request to point at somebody else. See
`docs/PARTNER.md`.

## Rewards

A count of **completed orders**, with marks at 25, 40 and 50, shown as one line
and a hairline bar under the order list and on the account screen.

It is a `count(*)` over orders in `order_status = 'COMPLETED'` — not a balance,
not points, not a wallet. There is no second number to keep in step with the
order list, and nothing that can double-count: a cancelled order is not
COMPLETED, so it is not in the count, and there is no separate record for it to
be missing from.

Reaching 50 writes one row in `customer_rewards`, unique on `(user_id, cycle)`,
so the 51st order finds it already there. **What the reward actually is, is not
in the software.** The screen says the goal has been reached and that Campus Dash
will be in touch, because promising a free lunch would create an obligation
nobody has agreed to. An administrator records what was given, at
`/admin/community`.

## Payment

The customer can _start_ a payment. They can never mark one paid.

```
customer taps Pay
     → startPayment()          server-side; amount comes from the ORDER
     → provider.initiateCollection()
     → provider settles
     → webhook → processPaymentWebhook() → confirm_payment()
```

Only a **verified provider event** moves `payment_status` to PAID.
`create_payment_intent`, `confirm_payment`, `fail_payment` and
`attach_payment_transaction` are not granted to any client role.

**Idempotent in three layers**, because someone on a bad connection taps twice:

1. an existing PENDING or SUCCEEDED payment is resumed, not replaced;
2. the key is `order:<id>:attempt:<n>`, so two simultaneous taps compute the
   same key and get one payment — while a retry after a genuine failure is a new
   attempt;
3. a partial unique index refuses a second live intent regardless.

Webhooks deduplicate on the provider's own event id, so a provider retrying five
times moves money once.

### The fake provider's callback

A real provider POSTs to `/api/payments/webhook/[provider]`. The fake one runs
inside this process and cannot reach us, so when it reports SUCCEEDED the poller
hands the same event to the same handler. **Only the transport is simulated** —
signature verification, deduplication and the state transition are all the
production path.

## Delivery is dispatched at PAYMENT

A delivery order stores its destination and its zone, and `delivery_status`
moves `NONE → SEARCHING` the moment `confirm_payment()` succeeds — not when the
food is ready. A Partner claimed while the kitchen works is a Partner who is not
found at the last minute and not left standing at a counter.

The offer carries `food_is_ready` so the Partner knows whether to set off or
wait, and `partner_confirm_pickup()` refuses until the order is READY — checked
before the code, so an eager attempt costs no attempt.

The customer sees their **own full destination** (`… / Floor 2 / Room 204`). The
store only ever sees the block.

## Not built

Editing a basket after submission, reordering, saved addresses, and any
customer-facing Partner profile beyond a first name and a phone number for the
length of one delivery.

A customer can still change **collection or delivery** while the order is
unpaid, and can walk away from an unpaid order entirely — the sweep cancels it
and nothing is charged. What they cannot do is unwind a PAID order: that is a
commitment on both sides, and undoing it is an admin action with a recorded
reason.
