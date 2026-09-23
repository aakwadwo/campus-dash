# Meal scans

A student holds a prepaid campus meal entitlement — a "scan". Some stores honour
it; some of those honour it for some of their menu. Campus Dash puts the order
on the store's board, charges a fee for doing so, and will send a Partner to
carry it if the student would rather not walk.

**A scan is a way of PAYING, not a different product.** Every decision below
follows from that one sentence, and from its immediate consequence: **the store
is the redemption point.** A restaurant that is going to hand food to somebody
has to know the order exists, know what was asked for, and be the party that
checks the scan before anything leaves the counter.

|                                 | Food order              | Scan order                        |
| ------------------------------- | ----------------------- | --------------------------------- |
| Customer pays for the food      | yes                     | **no — the scan does**            |
| Campus Dash food price          | the store's price       | **GH₵0**                          |
| Store entitlement in our ledger | the food subtotal       | **the pack, when one is charged** |
| Partner entitlement             | delivery fee            | delivery fee                      |
| Platform revenue                | service fee (% of food) | **flat fee**                      |
| Fulfilment                      | pickup or Partner       | pickup or Partner                 |
| On the store's board            | yes                     | **yes**                           |
| Daily queue number              | yes                     | **yes**                           |
| Who verifies the scan           | —                       | **the store**                     |
| Handoff                         | four digits             | **four digits**                   |

The meal entitlement is settled between the student and the university. Campus
Dash is not a party to it and never records its value as money owed.

> **This supersedes the earlier "scan errand" model**, in which Campus Dash sold
> the errand alone, no store ever saw the order, no queue number was allocated,
> and the Partner reported the redemption themselves. That model was wrong about
> the store's role, and everything that followed from it has been undone. See
> `supabase/migrations/20261002000001_scan_is_a_store_order.sql`.

## What a scan order costs

Every figure is read from `pricing_config`. Nothing is hard-coded, which is the
point: the pilot retunes at `/admin/pilot` without a deploy.

|                          | Collection, no pack        | Collection, with pack      | Campus Dash Partner             |
| ------------------------ | -------------------------- | -------------------------- | ------------------------------- |
| Food through Campus Dash | GH₵0.00                    | GH₵0.00                    | GH₵0.00                         |
| Service fee              | `scan_service_fee_pesewas` | `scan_service_fee_pesewas` | `scan_service_fee_pesewas`      |
|                          | GH₵2.00                    | GH₵2.00                    | GH₵2.00                         |
| Pack fee                 | —                          | `scan_pack_fee_pesewas`    | `scan_pack_fee_pesewas`         |
|                          | GH₵0.00                    | GH₵4.00                    | GH₵4.00, **compulsory**         |
| Campus Dash Partner      | —                          | —                          | `delivery_fee_pesewas`, GH₵5.00 |
| **Total**                | **GH₵2.00**                | **GH₵6.00**                | **GH₵11.00**                    |

### The service fee is FLAT, and never a percentage

**GH₵2.00 per scan order, on either fulfilment, whatever is in it.**
`service_fee_bps` — the 6.95% — belongs to FOOD orders and is never read by
`price_scan_order()`.

The reason is worth stating rather than assuming. The "scanned value" on a scan
order is the STORE'S menu price for food **Campus Dash did not sell**, settled
between the student and the university. A percentage of it would be a commission
on somebody else's transaction, and it would make the fee move with a number the
customer is not paying — a GH₵40 meal costing more to put on a board than a
GH₵10 one, for identical work.

**The two pricing systems do not meet.** `price_order()` charges
`service_fee_bps` of a real subtotal, because on a food order a real subtotal
exists and Campus Dash genuinely sold it. `price_scan_order()` charges
`scan_service_fee_pesewas` and reads `service_fee_bps` nowhere.

**The column stays nullable, and null is not zero.** Null means nobody has set a
price, and `price_scan_order()` refuses to quote rather than quietly giving the
service away. Zero would be a decision — a deliberately free one.

### The pack fee is a choice on a collection, and compulsory with a Partner

**GH₵4.00, and always its own line when it is charged.** The STORE packs the
meal, so **the pack fee is the store's money**: it is allocated to the vendor in
the same ledger row, and split to the store's Paystack subaccount on the same
charge, as a food order's subtotal. It is never Campus Dash revenue and never
part of the Partner's GH₵5.

- **Collection:** the customer decides. Somebody walking to a counter can bring
  their own container, and charging GH₵4.00 for one they refused is charging for
  nothing. The checkout shows a checkbox, off by default.
- **Campus Dash Partner:** compulsory, and there is no "no pack" option. A
  Partner cannot carry a meal without something to carry it in, so the pack
  comes with the choice rather than beside it.

`p_wants_pack` is a **request, not an instruction**. On a Partner order
`price_scan_order()` ignores it and charges the pack regardless, so a request
that skipped the screen is overruled rather than honoured. `quote_scan_order()`
returns `pack_is_compulsory` so the checkout does not have to hold a second copy
of that rule.

`orders_pack_fee_scan_only` is a CHECK constraint rather than a convention, so
it cannot leak onto a food order however the calling code changes — a food order
arrives in the store's own packaging and is charged nothing for it.

It is **snapshotted onto the order** like every other figure, so raising it
tomorrow does not change what somebody already agreed to pay.

## Eligibility

Two switches, and both are required:

- `vendors.can_accept_scans` — the store honours meal scans at all. Set by an
  administrator at **Admin → Vendors → the store → Scan delivery**, audited like
  every other vendor change. Default false.
- `menu_items.scan_eligible` — this item may be paid for with one. Default
  false.

So a store opts in, and then chooses what it will honour a scan for: the rice,
yes; the imported drinks, no. `price_scan_order()` re-checks every item against
the live menu, so a screen that only offered eligible items is a convenience
rather than the enforcement.

**There is no separate way to browse.** `scan_restaurants()` and `scan_menu()`
are gone with the pages they served. A customer browses the one list of stores;
a store that takes a Meal Scan says **Meal Scan accepted** on its own page, and
the switch is on its ordinary checkout. The separate catalogue made a student
decide how they were paying before they had decided what to eat, and one who did
not know the feature existed never found it.

`can_accept_scans` is the administrator's, and only the administrator's:
`admin_set_vendor_scans()` is the single function in the schema that writes it,
and it is audited like every other vendor change.

## At the checkout

**Redeem by Meal Scan**, off by default, on an eligible store's ordinary
checkout. Turning it on changes three things and nothing else:

- the food line reads **GH₵0.00**, "Covered by your Meal Scan", because the
  university's entitlement settles it;
- a **photograph** of the scan becomes required;
- the order arrives on the store's board to be **verified before anything is
  cooked**.

The fulfilment choice, the destination, the basket and the single payment are
the same ones a food order uses. There is no second payment and no Meal Scan
fee: the flat `scan_service_fee_pesewas` REPLACES the 6.95%, it is not added to
it, and the line is labelled "Service fee" like any other.

### The photograph

**Photos only. PDF is gone.** It was accepted because some entitlements are
issued that way, which was true and cost more than it was worth: the customer
could not preview what they were about to send, the store had to open a document
viewer at a counter, and "choose a file" opened a document picker on a phone
when what everybody wanted was the camera roll. A screenshot of a PDF is a
photograph, and every phone takes one in two taps.

Two routes, and no third: **Choose a photo** (`accept` on the image types, which
is what makes a phone open the camera roll) and **Take a photo**. `uploadScan()`
refuses anything else before it reaches storage.

**The preview is the point.** The customer sees the actual image, full width,
before they pay, and can replace it as many times as they like — until the order
exists. After that the scan is FIXED: `order_scans` is keyed on the order, no
client holds a write grant on it, and there is no function anywhere that
attaches a second scan to a paid order. That would be a second entitlement
against one payment.

**The warning is the last thing before the total**: "Make sure your Meal Scan is
clear and fully visible. Once your order is paid for, payments related to an
invalid Meal Scan are non-refundable." The store checks after the money has
moved, and somebody about to pay is entitled to know that in the sentence before
they do.

## State

Scan orders reuse `order_status`, `payment_status` and `delivery_status`
unchanged, and add a **fourth independent dimension**, `scan_status`:

```
UPLOADED → REDEEMED
        ↘ REFUSED
```

| Value      | Means                                                    |
| ---------- | -------------------------------------------------------- |
| `UPLOADED` | on file; the customer, the store and an admin can see it |
| `REDEEMED` | **the store** has approved it. Dispatch opens here.      |
| `REFUSED`  | the store marked it invalid. **The order is cancelled.** |

It is a separate dimension because "the scan was honoured" and "somebody has the
food" are different claims, and hard rule 2 forbids merging state dimensions.

`RELEASED` remains in the enum and nothing writes it. It used to sit between
UPLOADED and REDEEMED and mean "the assigned Partner may read the image" —
see **Privacy** for why a Partner no longer reads one at all. Removing a value
from an enum is a rewrite of every column that uses it, and the point is that
nothing writes it any more, not that no row ever held it.

**APPROVAL IS THE GATE, and it is the whole shape of this flow.**

- `confirm_payment()` does **not** open dispatch for a scan order. It moves it
  to PREPARING and leaves `delivery_status` at NONE.
- `vendor_redeem_scan()` is the only statement that opens a scan order's
  search, in the same update that records the approval.
- `partner_accept_delivery()` requires `delivery_status = 'SEARCHING'` and, as
  belt, `scan_status = 'REDEEMED'` on a scan order.
- `vendor_mark_ready()` refuses while the scan is unsettled.

So "no Partner before approval" is a fact about the database rather than about a
button. Paying used to open the search, which offered Partners a job whose
entitlement nobody had looked at — and which the store might be about to refuse,
cancelling the order under them.

## The lifecycle

```
customer builds a basket, turns      scan_status  UPLOADED
  Redeem by Meal Scan on, attaches
  a photo, picks fulfilment          order_status ACCEPTED, queue number 001
pays the fee                         payment_status PAID
  → confirm_payment() reaches the store
                                     order_status PREPARING
                                     delivery NONE — nobody is sent for yet
THE STORE CHECKS THE MEAL SCAN
  Scan is good                       scan_status REDEEMED
                                     delivery SEARCHING, for a Partner order
  Scan is invalid                    scan_status REFUSED
                                     order_status CANCELLED_BY_VENDOR. STOP.
a Partner accepts                    delivery ASSIGNED
store presses Ready for pickup       order_status READY, handoff code minted
store reads the code out             whoever is collecting types it in
  collection: customer                order COMPLETED
  Partner:    partner_confirm_pickup  delivery PICKED_UP
              customer's code         delivery DELIVERED, order COMPLETED
```

The customer watches this on their own tracking page, which now has words for
the scan: `customer_order_stage()` reads the order type and the scan status as
well, so a paid order awaiting verification reads **Checking your Meal Scan**
rather than "Being prepared", and a refused one reads **Meal Scan not accepted**
with a way to order again rather than a bare "Cancelled".

Two things are worth spelling out.

**Payment reaches the store, exactly as it does for a food order.** The only
branch `confirm_payment()` carries is the dispatch one above: a scan order's
search is not opened at payment because the store has not looked at the scan
yet.

**Ready is refused until the scan is settled.** `vendor_mark_ready()` will not
move a scan order whose `scan_status` is still UPLOADED. Pressing Ready is what
mints the four digits somebody will be asked for, and minting them before
anybody has looked at the scan would put food on a counter for an entitlement
that might not exist.

## Redemption is the store's act

`vendor_redeem_scan()` is a deliberate, separate act by the restaurant. It used
to be `partner_report_scan_redeemed()` — the Partner recording their own account
of what a counter had done — and that was wrong twice over: the Partner cannot
verify somebody else's system, and a second road to REDEEMED from the other side
of the counter is exactly the asymmetry hard rule 11 exists to prevent. Both
Partner functions are **dropped**, not merely revoked.

Double redemption is refused by a conditional update guarded on the current
scan status. The second attempt matches zero rows, returns `{ success: false }`
and is logged as a rejection.

The store gets exactly two buttons: **Scan is good** and **Scan is invalid**.

### Scan is invalid ends the order

`vendor_refuse_scan()` sets `scan_status = REFUSED` **and cancels the order in
the same statement** — `CANCELLED_BY_VENDOR`, with the store's reason on
`orders.cancellation_reason`. It used to stop at REFUSED and leave the order
PREPARING, which is a state where a store that had just said it would not
honour the entitlement could still press Ready on the food.

Afterwards nothing can be done with the order: Ready is refused, redeeming is
refused, no Partner can be assigned, and **there is no path that attaches a
second scan to it**. That would be a second entitlement against one payment, so
there is no "replace scan" and no "retry" function, by design. The customer
places a completely new order.

It is **irreversible**, so the vendor screen asks first. The confirmation names
every consequence — the order ends, the customer must order again, they cannot
attach another scan, the payment is not refunded, it cannot be undone — and asks
for a reason before the button will do anything.

**The customer is texted**, because this ends their order while they are not
looking at it: `SCAN_REFUSED` to the CUSTOMER and nobody else. The message says
the scan was not accepted, that the order is cancelled, that it cannot be
refunded, and to order again. It does **not** carry the store's reason:
forwarding "already used today" to a phone accuses somebody of something in a
message they cannot reply to. The reason is on the tracking page and in the
audit trail, where there is room for it and somebody to answer.

**No money moves**, still. A refused scan appears in `admin_exceptions()`
flagged as requiring a decision, and it is matched before the order status is
read, so cancelling the order does not hide it.

### What Campus Dash does and does not guarantee

**Campus Dash guarantees that its own order cannot be redeemed twice through
this workflow.**

It does **not** guarantee that the underlying entitlement is valid, and it
cannot: there is no integration with the university's scan system. What the new
model does buy is that the party making the judgement is now the party that can
actually make it — the counter staff looking at the scan, with the food in front
of them — rather than a student holding a phone.

## What the customer may add

An optional free-text note, `order_scans.details`, asked as "Anything the store
should know". It **used to be required**, because it was the only way anybody
knew what to hand over. The order carries real items now, so the note is what it
should always have been: context — "no pepper", "the far counter".

## Privacy

The image lives in the private `scan-documents` bucket, which has **no policies
on `storage.objects` at all**, so RLS denies every client read and write and only
the service role can touch a file. Nobody ever receives a storage URL — only a
short-lived signed URL minted server-side after the caller's right has been
re-checked in SQL.

**Three readers, and two doors.**

| Reader                       | Door                       | Window                    |
| ---------------------------- | -------------------------- | ------------------------- |
| the customer who uploaded it | `scan_image_path()`        | always                    |
| the **store honouring it**   | `vendor_scan_image_path()` | paid → leaves their board |
| an administrator             | `scan_image_path()`        | always                    |

**A PARTNER IS NOT ON THAT LIST, AT ANY POINT.** They used to be: released on
assignment, shut at the end of the delivery, because the Partner carried the
entitlement to a counter that had never seen the order. The store has the order
on its own board now and approves the scan **before dispatch even opens**, so by
the time anybody is carrying anything the entitlement has already been judged by
the only party that could judge it. A Partner holding a link to somebody's meal
entitlement is exposure with nothing on the other side of it, so the right was
removed rather than narrowed: `partner_may_read_scan()` and
`partner_scan_brief()` are **dropped**, the release trigger with them, and the
`order_scans` policy no longer names a Partner. An offer carries no scan — a
Partner sees store, zone, payout and timing, and decides on that.

The store's window opens when the order is paid for and closes when it leaves
the board: an authorisation that outlives the thing it was granted for is not an
authorisation, it is a copy. `vendor_may_read_scan()` is the single predicate
behind both that function and the `order_scans` RLS policy, so the row and the
image can never disagree about who may look. It is a SECURITY DEFINER function
rather than a subquery because vendors read orders only through RPCs and hold no
SELECT grant on `public.orders` — an `exists (select 1 from public.orders …)`
inside a policy would evaluate against a table the vendor cannot see and be
permanently false.

**One image per order, and it is fixed at submission.** `order_scans` is keyed
on `order_id`, no client role holds INSERT or UPDATE on it, and no function
replaces an image. The customer previews and re-chooses as often as they like
before the order exists; afterwards there is no path, which is what makes "the
scan cannot be replaced on a paid order" a property of the schema rather than a
rule a screen remembers.

Upload paths are `<user_id>/scans/<random>`, built from the session and never
from the request. `submit_scan_order()` re-checks the prefix before attaching a
scan, so a forged path fails twice.

### What the store is NOT shown

Putting a scan order on the board necessarily shows a store more than it saw
before. The extra exposure is **the scan and the items, and nothing else**.
`vendor_order_board()` and `vendor_order_detail()` return no destination, no
destination note, no customer phone number and no customer total — and that is
now true of food orders too. A store hands food across a counter to whoever
reads back four digits; where it goes afterwards is the Partner's business and
the customer's. The destination ZONE used to be returned as "useful context"; it
was a customer's whereabouts shown to a room, and it went with the rest.

## The ledger

The store's share of any order is `subtotal_pesewas + pack_fee_pesewas`. On a
scan order the subtotal is zero, so **the store's share is the pack**, and
`create_order_allocations()` writes a VENDOR row for it. A scan collection
without a pack writes **no VENDOR row** at all, not a zero-value one: a
zero-pesewa liability tells a reader the store is owed something by Campus Dash,
and it is not. The food itself is settled by the university's system.

```
Partner order                GH₵11.00  GH₵2.00 fee + GH₵4.00 pack + GH₵5.00 Partner
VENDOR allocation            GH₵4.00   the pack, at payment (split, or the daily run)
PLATFORM allocation          GH₵7.00   at payment
PARTNER allocation           GH₵5.00   carved out of PLATFORM on delivery
net platform                 GH₵2.00   the flat fee

Collection with a pack       GH₵6.00   VENDOR GH₵4.00, PLATFORM GH₵2.00
Collection without a pack    GH₵2.00   PLATFORM GH₵2.00, no VENDOR row
```

**The same figures whatever was ordered.** A GH₵42.00 tilapia and a GH₵38.00
waffle produce identical allocations, because the fee is flat and the scanned
value never enters the arithmetic. `tests/scan-pack-allocation.test.js` pins
every case.

The items on the order carry their menu prices so the counter can see what was
asked for and what it is normally worth, but `orders.subtotal_pesewas` stays
**zero** — nothing ties the two together, and `orders_scan_has_no_food_value`
refuses any attempt to change that.

The store's board shows **Pack included** on a scan order that has one, because
somebody has to put the food in it. What the pack is worth to the store is on
the order screen, not the card.

**Paystack's processing fee is a platform expense by construction rather than by
policy.** `payments` records only the gross amount collected; there is no fee
column anywhere in the schema, and allocations are derived from
`orders.total_pesewas`. So nothing can deduct a processing fee from what the
Partner is owed — the cost lands on the platform's share because that is the
only place left for it to land.

## Failure, and what is deliberately undecided

Failures are recorded, separated and left for a person. **No automatic refunds
exist, because no refund policy has been decided.** This is not an oversight; it
is the absence of a business rule, and inventing one in a database function
would be the wrong place to invent it.

| What happened                | Recorded as                                         | Money                      |
| ---------------------------- | --------------------------------------------------- | -------------------------- |
| Store refuses the scan       | `scan_status = REFUSED` + the store's reason        | untouched — admin resolves |
| No Partner accepts           | `delivery FAILED_NO_PARTNER`, scan stays `UPLOADED` | existing no-partner path   |
| Partner loses the assignment | scan un-released, back to `UPLOADED`                | order returns to search    |
| Redeemed but delivery fails  | existing delivery-failure paths                     | unchanged                  |
| Customer disputes receipt    | existing dispute paths                              | unchanged                  |

An administrator resolves these with the existing `admin_mark_refunded()` and
`admin_resolve_dispute()`, both of which append to `admin_actions`. A refused
scan appears in `admin_exceptions()` flagged as requiring a decision.

**Cancellation before assignment is also undecided** and is not implemented. A
customer cannot cancel a paid scan order themselves.

## Conflict of interest

Unchanged and fully applied. A Partner cannot carry their own scan order, and
cannot carry one from a store they own. Both predicates read
`orders.customer_id` and `orders.vendor_id`, which a scan order populates the
same way, so no special case was needed or added.

## Stores

Wafflemania and Yellow Bar exist in the **local seed only**, as
`Wafflemania (test)` and `Yellow Bar (test)`. `supabase/seed.sql` is never
applied to a hosted project. The real stores are created in production through
`/admin/vendors`, against the same vendor model.

They are **owned** in the seed, and they have to be: a store that takes meal
scans has a board to check them from, and none of that is possible for a
catalogue entry with a NULL owner — which is what they used to be, when Campus
Dash sold the errand and the store had no part in it.

## Not built, on purpose

No integration with the university's scan system, no QR or barcode verification,
no store-side hardware, no automatic reconciliation, no GPS. For V1 the scan is
a securely stored artifact that the person collecting carries to the counter and
the store checks through the process that already exists there.
