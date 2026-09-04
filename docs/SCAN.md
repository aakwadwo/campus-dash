# Scan delivery

A student already holds a prepaid campus meal entitlement — a "scan" — and does
not want to walk to the restaurant. Campus Dash sends a Partner to redeem it and
bring the food.

**Campus Dash does not sell the food. It sells the errand.** Every design
decision below follows from that one sentence.

|                                  | Food order                        | Scan delivery                |
| -------------------------------- | --------------------------------- | ---------------------------- |
| Customer pays                    | food + service fee + delivery fee | service fee + delivery fee   |
| Campus Dash food price           | the vendor's price                | **GH₵0**                     |
| Vendor entitlement in our ledger | the food subtotal                 | **none — no row is written** |
| Partner entitlement              | delivery fee                      | delivery fee                 |
| Platform revenue                 | service fee                       | scan service fee             |
| Fulfilment                       | pickup or delivery                | **delivery only**            |
| Vendor acts in the app           | accepts, prepares, marks ready    | **never**                    |

The meal entitlement is settled between the student and the university. Campus
Dash is not a party to it and never records its value.

## The fee

`service_fee_bps` is a percentage of the food subtotal. A scan order has no
subtotal, so that formula yields zero — and because
`partner_share_of_delivery_bps` is 10000, the Partner already takes the whole
delivery fee. A zero fee would mean running every scan order at a loss once
Paystack takes its cut.

So the scan fee is a **flat GH₵2.00 per errand**, held in its own column,
`pricing_config.scan_service_fee_pesewas` (200 pesewas), editable at
`/admin/pilot`. The migration installs that value, so a hosted project is priced
correctly the moment it is applied.

It is **not** a percentage of anything. There is no Campus Dash food value to
take a percentage of, and the meal's face value belongs to the university's
system rather than to our pricing. The errand is the same work whether the meal
is worth GH₵10 or GH₵40.

**The column stays nullable, and null is not zero.** Null means nobody has set a
price, and `price_scan_order()` refuses to quote rather than quietly giving the
errand away. Zero would be a decision — a deliberately free errand.

A scan order therefore costs:

| Line                     | Amount      |
| ------------------------ | ----------- |
| Food through Campus Dash | GH₵0.00     |
| Delivery fee             | GH₵5.00     |
| Scan service fee         | GH₵2.00     |
| **Customer pays**        | **GH₵7.00** |

## State

Scan orders reuse `order_status`, `payment_status` and `delivery_status`
unchanged, and add a **fourth independent dimension**, `scan_status`:

```
UPLOADED → RELEASED → REDEEMED
                   ↘ REFUSED
```

| Value      | Means                                                   |
| ---------- | ------------------------------------------------------- |
| `UPLOADED` | on file; only the customer and an admin can see it      |
| `RELEASED` | an assigned Partner may read it, and only that Partner  |
| `REDEEMED` | the assigned Partner reports the restaurant honoured it |
| `REFUSED`  | the restaurant would not honour it. **No money moves.** |

It is a separate dimension because "the Partner has the food" and "the scan was
redeemed" are different claims, and hard rule 2 forbids merging state
dimensions.

## The lifecycle

```
customer uploads the scan          scan_status  UPLOADED
picks restaurant + destination     order_status ACCEPTED   (no vendor involved)
pays service + delivery fee        payment_status PAID
  → confirm_payment() opens dispatch
                                   order_status READY, delivery SEARCHING
a Partner accepts                  delivery ASSIGNED, scan_status RELEASED
Partner redeems at the counter     scan_status REDEEMED, delivery PICKED_UP
Partner delivers, customer's code   delivery DELIVERED, order COMPLETED
```

Two things are worth spelling out.

**The order is born ACCEPTED with no vendor asked.** There is nothing for the
restaurant to accept, cook or price. It never appears on a vendor board, and
`vendor_order_board()` / `vendor_pending_count()` filter scan orders out.

**Payment opens dispatch.** A food order reaches `SEARCHING` when the vendor
marks it READY. Nobody cooks for us here, so `confirm_payment()` moves a scan
order to READY/SEARCHING itself. This preserves the invariant that a Partner
never sees an unpaid order.

## Redemption is not acceptance

`partner_report_scan_redeemed()` is a separate, explicit act. It is also the
scan order's only road to `PICKED_UP` — there is no vendor to press a pickup
button — and `partner_complete_delivery()` still requires `PICKED_UP`. A Partner
who never redeems therefore cannot complete the delivery.

Double redemption is refused by a conditional update guarded on
`scan_status = 'RELEASED'`. The second attempt matches zero rows, returns
`{ success: false }` and is logged as a rejection.

### What Campus Dash does and does not guarantee

**Campus Dash guarantees that its own order cannot be redeemed twice through
this workflow.**

It does **not** guarantee that the underlying entitlement is still valid, and it
cannot. There is no integration with the university's scan system. A screenshot
can be shown at a counter by anybody; the restaurant's own process is the
authority on whether a scan is live. That is why the function is named
`partner_report_scan_redeemed` — it records a person's account of what happened,
not a verification. If an official integration ever exists, it can become
authoritative and this becomes a fallback.

## Privacy

The image lives in the private `scan-documents` bucket. Like
`partner-documents`, it has **no policies on `storage.objects` at all**, so RLS
denies every client read and write and only the service role can touch a file.
Nobody ever receives a storage URL — only a short-lived signed URL minted
server-side after the caller's right has been re-checked in SQL.

Exactly three readers, enforced in `scan_image_path()` and in the
`order_scans` RLS policy:

- the customer who uploaded it
- the **currently** assigned Partner
- an administrator

`order_scans.released_to` is rewritten in the same statement that moves the
assignment, so a Partner who loses the job loses the scan on their very next
request. There is no window in which two Partners can read it. An offer carries
no scan — a Partner sees restaurant, zone, payout and timing, and decides on
that.

Upload paths are `<user_id>/scans/<random>`, built from the session and never
from the request. `submit_scan_order()` re-checks the prefix before attaching
a scan, so a forged path fails twice.

## The ledger

`create_order_allocations()` writes **no VENDOR row** for a scan order — not a
zero-value one. A zero-pesewa liability is still a liability on the books: it
shows up in settlement queries and tells a reader the restaurant is owed
something. It is not.

```
customer pays          GH₵7.00   service fee + delivery fee
PLATFORM allocation    GH₵7.00   at payment
PARTNER allocation     GH₵5.00   carved out of PLATFORM on delivery
net platform           GH₵2.00   the scan service fee
VENDOR allocation      — no row is written at all —
```

**Paystack's processing fee is a platform expense, and it is a platform expense
by construction rather than by policy.** `payments` records only the gross amount
collected; there is no fee column anywhere in the schema, and allocations are
derived from `orders.total_pesewas`. So nothing can deduct a processing fee from
what the Partner or a vendor is owed — the cost lands on the platform's share
because that is the only place left for it to land.

## Failure, and what is deliberately undecided

Failures are recorded, separated and left for a person. **No automatic refunds
exist, because no refund policy has been decided.** This is not an oversight; it
is the absence of a business rule, and inventing one in a database function
would be the wrong place to invent it.

| What happened                   | Recorded as                                         | Money                         |
| ------------------------------- | --------------------------------------------------- | ----------------------------- |
| Restaurant refuses the scan     | `scan_status = REFUSED`                             | untouched — admin resolves    |
| Scan already redeemed elsewhere | `scan_status = REFUSED` + reason                    | untouched — admin resolves    |
| No Partner accepts              | `delivery FAILED_NO_PARTNER`, scan stays `UPLOADED` | existing no-partner behaviour |
| Partner loses the assignment    | scan un-released, back to `UPLOADED`                | order returns to search       |
| Redeemed but delivery fails     | existing delivery-failure paths                     | unchanged                     |
| Customer disputes receipt       | existing dispute paths                              | unchanged                     |

An administrator resolves these with the existing `admin_mark_refunded()` and
`admin_resolve_dispute()`, both of which append to `admin_actions`.

**Cancellation before assignment is also undecided** and is not implemented. A
customer cannot cancel a paid scan order themselves.

## Conflict of interest

Unchanged and fully applied. A Partner cannot deliver their own scan order, and
cannot deliver one from a restaurant they staff. Both predicates read
`orders.customer_id` and `orders.vendor_id`, which a scan order populates the
same way, so no special case was needed or added.

## Restaurants

A vendor accepts scans only when `vendors.can_accept_scans` is true, set by an
administrator at **Admin → Vendors → the stall → Scan delivery**, audited like
every other vendor change. Default false: a scan errand sends a Partner to a
counter expecting to be served without paying, and being wrong about that costs
the Partner a walk and the customer their lunch.

Wafflemania and Yellow Bar exist in the **local seed only**, as
`Wafflemania (test)` and `Yellow Bar (test)`. `supabase/seed.sql` is never
applied to a hosted project. The real restaurants are created in production
through `/admin/vendors`, against the same vendor model.

## Not built, on purpose

No integration with the university's scan system, no QR or barcode verification,
no restaurant-side hardware, no automatic reconciliation, no GPS. For V1 the
scan is a securely stored artifact the assigned Partner carries to the counter
and uses through the process that already exists there.
