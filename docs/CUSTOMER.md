# Customer Ordering

One job: a student on a phone picks food from an approved stall and pays for it.

## Browsing is open; ordering is a capability

Anyone can look. `vendors`, `menu_items` and `locations` are readable by `anon`
under their own RLS policies, so `/order` runs the same queries signed out as it
does signed in, and someone can build a basket before they have an account.

Placing an order needs the **CUSTOMER capability**, which is a
`customer_profiles` row, which is acquired by completing student onboarding:

- full name
- student ID number
- class year
- a unique email address
- a photograph of the student ID
- acceptance of the current customer terms

`complete_customer_onboarding()` writes all of it in one transaction, including
the terms acceptance — a capability granted before the agreement it depends on
is a gate that opens itself. There is no admin review: completing the form **is**
the grant.

The student ID photograph goes into the same private bucket as the Partner face
photograph, with no storage policies — only an administrator can see it, through
a short-lived signed URL. It is **retained while the account holds the Customer
capability**, because it is the standing evidence for that capability rather
than a record of a past decision, and the Partner document purge does not touch
it. How it is eventually deleted is an open policy item — see
`docs/PILOT-QUESTIONS.md` question 18b.

It is not a new account. The identity already exists — a phone number was
verified to get this far — so onboarding only ever adds a capability to the
`auth.users.id` already in the session. An administrator or a vendor account
that has not done it genuinely cannot order, because `submit_order_for()`
asserts `is_customer()` server-side rather than trusting a screen.

## The flow, and why it is in this order

```
pick items  →  submit  →  VENDOR ACCEPTS  →  customer pays  →  vendor cooks  →  READY
                              │
                         or rejects / no answer → nothing is charged, ever
```

The vendor accepts **before** the customer pays. That is the whole reason
`order_status` and `payment_status` are separate fields: an order can be
accepted and unpaid, or paid and not yet cooked, and neither implies the other.
A single status column would have forced a choice between charging people for
food that was never accepted, or letting vendors cook for people who never paid.

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

| Stage                                           | Means                                       |
| ----------------------------------------------- | ------------------------------------------- |
| `AWAITING_VENDOR`                               | 60-second countdown. Nothing charged.       |
| `PAYMENT_REQUIRED`                              | Accepted. Pay now.                          |
| `PAYMENT_PROCESSING`                            | Charge in flight. Do not pay again.         |
| `PAYMENT_FAILED`                                | Nothing taken. Retry creates a new attempt. |
| `PAID_AWAITING_KITCHEN` / `PREPARING` / `READY` | Progress.                                   |
| `REJECTED` / `EXPIRED` / `CANCELLED`            | Over, with the reason, and no charge.       |

Deriving this once in SQL means no screen has to reason about how the three
dimensions interact — which is exactly where a UI gets it wrong.

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

## Delivery is recorded, not dispatched

A delivery order stores its destination and its zone, and `delivery_status`
stays `NONE` until the vendor marks the food READY. No Partner is sought during
Phase 6. That is not a gap in the customer flow; it is where dispatch belongs.

The customer sees their **own full destination** (`… / Floor 2 / Room 204`). The
vendor only ever sees the block.

## Not built

Cancelling an order after submission, editing a basket after submission,
reordering, saved addresses, and any customer-facing view of a Partner. The
first two are deliberate: once a vendor has accepted, the order is a commitment
on both sides, and unwinding it is an admin action with a recorded reason.
