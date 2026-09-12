# Notifications

SMS is the primary channel. In-app alerts supplement it. There is no push
infrastructure, deliberately.

## The seam

Business logic emits a **domain event**; it never touches a provider and never
composes copy.

```
transition succeeds
  → notifyOrderEvent(EVENT, orderId, extra)
  → audience list          lib/orders/notify.js
  → copy                   lib/notifications/templates.js
  → SmsProvider.send()     lib/sms/
  → notification_events    the delivery record
```

Swapping FakeSmsProvider for a Ghana provider is one new file and one case in a
factory. No business logic moves.

## Who hears what

| Event                 | Customer             | Store                       | Partner                        |
| --------------------- | -------------------- | --------------------------- | ------------------------------ |
| Order created, unpaid |                      |                             |                                |
| **Payment confirmed** | ✓                    | ✓ _(NEW PAID ORDER + link)_ |                                |
| Ready                 | ✓ _(how to collect)_ |                             |                                |
| Partner assigned      | ✓ _(delivery code)_  | ✓ _(no code)_               | ✓ _(earnings, wait for Ready)_ |
| Partner picked up     | ✓                    |                             | ✓                              |
| Delivered             | ✓                    |                             | ✓ _(added to earnings)_        |
| Cancelled             | ✓                    | ✓                           | ✓                              |

**NOBODY IS TEXTED WHEN AN ORDER IS CREATED.** It is not a ticket yet — nothing
has been paid, and the customer is looking at the pay button as the message
would arrive. A store's "new order" message is the PAYMENT one, and it says PAID
because that is the fact that makes the order real. There is no accept-or-reject
prompt in it, because there is nothing left to accept.

**No handoff code is ever sent by SMS**, to anybody. The store reads theirs off
their own screen, behind their own session; a message is a copy in a second
place that outlives the delivery it was sent for.

**For a collection, the READY message explains the handoff** — "they will give
you a 4-digit code, enter it in the app". That code does not exist until the
food is made, and somebody about to walk to a counter expecting to simply be
handed food needs to be told once.

An audience with no template is simply not notified — a missing entry is how an
event stays quiet, not a bug.

## Deduplication

A notification is identified by **what it is**: `event : audience : order :
recipient`. Sending the same one twice is a duplicate however many times the
code path ran — and server actions retry, pages revalidate, and people tap
buttons twice on bad connections.

The check happens **before** sending. Logging a duplicate afterwards is useless:
the money is spent and the phone has buzzed. A partial unique index on
successful sends is the backstop.

**Failures stay retryable.** Only successes are deduplicated, and every attempt
is recorded — `admin_failed_notifications()` lists what still needs chasing and
drops a message as soon as any attempt gets through.

## Cost

Every send is recorded, so SMS volume is measurable from day one:
`notifications_per_order` on `/admin/pilot`. In Ghana this is a real bill, and
the pilot is expected to prune the list — see `docs/PILOT-QUESTIONS.md`.

## The log

`notification_events` answers: what was sent, to whom, when, over what channel,
and whether it worked. It is append-only — a delivery record you can edit is
not a record — and readable only by an admin, because it contains phone numbers
and message bodies.

## Failure never rolls anything back

A dropped SMS must not undo a state transition that already happened. The order
is real whether or not the message arrived. Failures are logged and swallowed,
and surface on the admin screen rather than as an exception the customer sees.

## Delivery reports

A send being accepted and a message arriving are different facts, and the
notification log now records both. `succeeded` says the provider took it;
`delivery_status` says what happened afterwards, and stays null until the
provider reports.

The correlation is ours. Arkesel's v1 send response carries no message id, so
`notify()` generates a UUID before sending, hands it to the adapter, and the
adapter puts it in the per-message callback URL. Arkesel gives it back on the
report, which is matched to the row by `correlation_id`.

`notification_events` remains append-only. The guard was narrowed, not removed:
DELETE is still forbidden, and UPDATE is permitted only when the sole columns
that changed are the three a delivery report fills in — with
`provider_message_id` write-once. Everything that records who was told what, and
when, is still immutable. `tests/audit.test.js` pins down exactly that.

`admin_undelivered_notifications()` answers the question the reports make
answerable: what did not arrive.

Full setup, the signature scheme and troubleshooting: [`SMS.md`](./SMS.md).

## The events that are not about an order

`lib/orders/notify.js` turns an order transition into messages. Three other
kinds go through `lib/notifications/dispatch.js`, and each resolves its
recipients with a **service-only** database function — because each returns
somebody's phone number to a caller who is not that person, which is the
definition of a question a client must not be able to ask.

| Event                                   | Who hears it                      | Recipient list                  |
| --------------------------------------- | --------------------------------- | ------------------------------- |
| `VENDOR_APPROVED` / `VENDOR_REJECTED`   | the store's owner                 | `vendor_owner_contact()`        |
| `PARTNER_APPROVED` / `PARTNER_REJECTED` | the applicant                     | the account itself              |
| `DELIVERY_AVAILABLE`                    | every eligible, available Partner | `partners_to_notify_of_offer()` |
| `PAYOUT_SENT`                           | the payee                         | `payout_recipient_contact()`    |

`DELIVERY_AVAILABLE` is a **broadcast**, and the copy reflects that: it says a
delivery exists and links to the dashboard. No customer, no destination, no
amount owed to a named person. Eligibility is re-derived in SQL from the same
rules the offer list uses, so nobody is texted about work they would then be
refused — and the notification layer dedupes per order per recipient, so a
retried transition does not buzz forty phones twice.

`PAYOUT_SENT` fires on **PAID**, never on PROCESSING: a transfer the provider
merely accepted is not money that has arrived. It names an amount and a link and
deliberately **not a rail** — an administrator may settle by bank transfer, by
mobile money or in cash, and naming the wrong one is worse than naming none.

The capability decisions carry a `dedupeSubject` rather than an order id, so a
double-clicked admin button cannot send the same congratulations twice.

## Two things that must never be in an SMS

**A customer's phone number.** It was in `PARTNER_PICKED_UP`. An SMS is
forwardable, screenshottable and permanent, and it outlives the delivery it was
sent for; the dashboard's copy expires when the authorisation does.

**A handoff code, to anybody.** The store reads it off their own screen; nobody
receives it by SMS. Putting it in a message would give the person collecting
both halves of the proof, and would leave a copy of it on a phone long after the
delivery it belonged to was over.

## Names in messages

A message that names a person names them by **first name only**, and only when
the recipient is entitled to know who they are.

- `PARTNER_ASSIGNED` tells the CUSTOMER "Kwame has accepted your order". A
  surname adds nothing to finding somebody at your door and is theirs, not ours
  to hand out.
- The same event tells the PARTNER the order number, the vendor and their
  earning, and **no customer name and no customer phone number**. Both are on
  the dashboard, gated on this Partner still being the assigned one — and an
  SMS outlives that gate. It is forwardable, screenshottable and permanent.
- `DELIVERY_AVAILABLE` goes to every available Partner and therefore carries
  nothing about anybody: no customer, no destination, no name, no amount owed to
  a named person. Its whole job is to get somebody to open their own dashboard.

`lib/orders/notify.js` derives the first name with `firstNameOf()`, which falls
back to the first word of a legacy `full_name` for accounts created before the
name was split.
