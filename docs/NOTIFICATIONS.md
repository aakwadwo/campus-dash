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

These are the ORDER-SCOPED events a live order actually fires, and the table is
the one in `lib/orders/notify.js`. A blank cell is silence, and silence is the
default: what somebody is not texted about is on the screen that belongs to them
— the customer's tracking page, the store's board, the Partner's dashboard.

`AUDIENCES` also still carries entries for `ORDER_SUBMITTED`, `ORDER_ACCEPTED`,
`ORDER_REJECTED` and `ORDER_PREPARING`. Nothing emits any of them: they belong
to the vendor-acceptance flow that paid-first ordering removed, and they are
left in place for the same reason the `order_status` enum keeps REJECTED and
EXPIRED — real rows still point at that history. They are not part of the policy
below.

The capability messages — approval and rejection for a store or a Partner, the
offer broadcast, a payout — are not order-scoped and are sent from
`lib/notifications/dispatch.js`. See **Names in messages** for what each carries.

| Event                 | Customer                    | Store                       | Partner                 |
| --------------------- | --------------------------- | --------------------------- | ----------------------- |
| Order created, unpaid |                             |                             |                         |
| **Payment confirmed** |                             | ✓ _(NEW PAID ORDER + link)_ |                         |
| Ready — collection    | ✓ _(how the handoff works)_ |                             |                         |
| Ready — Partner order |                             |                             | ✓ _(go and collect it)_ |
| Partner assigned      | ✓ _(who took it. NO CODE)_  |                             |                         |
| Partner picked up     |                             |                             |                         |
| Delivered             |                             |                             |                         |
| Cancelled             | ✓                           | ✓                           |                         |

READY is ONE event with one audience list (`[CUSTOMER, PARTNER]`) and is split
into two rows here because the template decides the rest: `renderSms` returns
null for a customer whose order a Partner is bringing, so that audience resolves
to a skip. Somebody about to walk to a counter needs to know when; somebody
waiting in their room is watching the page.

**NOBODY IS TEXTED WHEN AN ORDER IS CREATED.** It is not a ticket yet — nothing
has been paid, and the customer is looking at the pay button as the message
would arrive. A store's "new order" message is the PAYMENT one, and it says PAID
because that is the fact that makes the order real. There is no accept-or-reject
prompt in it, because there is nothing left to accept.

**THE CUSTOMER IS NOT TEXTED THAT THEIR PAYMENT SUCCEEDED.** They are holding
the phone that just told them.

**No handoff code is ever sent by SMS, to anybody — and that now includes the
customer's own delivery code.** All three codes are four digits and every one of
them lives on exactly one screen, behind exactly one session: the store reads
the handoff code off their own board, and the customer reads their delivery code
off their own tracking page. An SMS is a copy in a second place, and it is
forwardable, screenshottable and permanent — it outlives by months the delivery
it was sent for. PARTNER_ASSIGNED used to end "Your code is 4821. Give it to
them on arrival"; it now says who took the order and sends them to the screen.
`tests/sms-rules.test.js` plants both codes in the context and asserts that no
template anywhere renders either.

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

## Operational email, which is not an SMS and not for a customer

One message goes out by **email**, and it is the only one: a vendor's Paystack
subaccount was created. It is not addressed to a customer, a vendor or a
Partner — it tells whoever runs the pilot that a store's payout plumbing now
exists, so their share of every later charge is routed to them at the moment the
customer pays.

```
syncPayoutSubaccount()            lib/settlement/destinations.js
  → Paystack issues a code
  → attachPayoutSubaccount()      the code is stored
  → deferNotification(...)        after the response
  → notifyAdminSubaccountCreated() lib/notifications/admin-email.js
  → EmailProvider.send()          lib/email/
  → notification_events           channel EMAIL, audience ADMIN
```

**It is a separate path from `notify()` on purpose.** That function is SMS end
to end — it renders from `SMS_TEMPLATES`, skips a recipient with no phone
number, and records every row as `CHANNEL.SMS`. Teaching it a second transport
would mean rewriting the path every order notification already takes, to carry a
message no order depends on.

**Where it fires is the whole design.** `syncPayoutSubaccount()` has four exits
and only one of them is a creation: a destination that is already registered
returns early, a Paystack refusal is recorded and returns, and a provider with
no subaccounts returns too. The email sits after the code has been stored and
before success is returned, so it goes out once per subaccount that actually
came into existence — never on a failure, and never again on a retry. The dedupe
key is the subaccount code itself, which is the second belt: a genuinely NEW
code (a vendor changed their number, so the old one was cleared) is a genuinely
new notification, because that is a thing worth hearing about.

**The recipient is `ADMIN_NOTIFICATION_EMAIL`, deliberately not an
administrator's sign-in address.** That is a credential; who receives
operational mail is a different concern and should be changeable without
touching who can sign in. Unset, nothing is sent and nothing is recorded — a
quiet deployment rather than a broken one.

The account number is masked to its last three digits, exactly as
`my_payout_destination()` and `admin_payout_readiness()` mask it. An email sits
in an inbox for years.

### Setting it up, which is two variables

`EMAIL_PROVIDER=fake` prints the message to the server console and costs
nothing. That is the default and is enough for development.

To send for real, the whole setup is:

```
EMAIL_PROVIDER=resend
RESEND_API_KEY=re_...
```

**No domain to verify and no sending address to configure.** `EMAIL_FROM_ADDRESS`
defaults to Resend's shared onboarding sender, which needs neither. The one
string attached is that this sender may only deliver to the address the Resend
account was created with — anything else is a 403 — so sign up to Resend with
the same address as `ADMIN_NOTIFICATION_EMAIL`. For a pilot notifying one
person, that is the setup rather than a limitation. Set `EMAIL_FROM_ADDRESS`
only once a real domain is verified on the account.

Swapping providers is one new file in `lib/email/` and one case in the factory,
exactly as it is for SMS.

## Two things that must never be in an SMS

**A customer's phone number.** It was in `PARTNER_PICKED_UP`. An SMS is
forwardable, screenshottable and permanent, and it outlives the delivery it was
sent for; the dashboard's copy expires when the authorisation does.

**A handoff code, to anybody — including the customer's own delivery code.** The
store reads the handoff code off their own screen and the customer reads their
delivery code off theirs; neither arrives by SMS. Putting the store's in a
message would give the person collecting both halves of the proof. The
customer's was in one for a while, and the objection to it is the second half of
the same sentence: a message leaves a copy of a four-digit secret on a phone
long after the delivery it belonged to was over, and it can be forwarded to
somebody who was never entitled to it.

## Names in messages

A message that names a person names them by **first name only**, and only when
the recipient is entitled to know who they are.

- `PARTNER_ASSIGNED` tells the CUSTOMER "Kwame has accepted your order", and
  nothing else — no code, no phone number, no amount. A surname adds nothing to
  finding somebody at your door and is theirs, not ours to hand out.
- **The same event tells the PARTNER nothing at all.** There is no PARTNER
  template for it and the audience list does not name them: they pressed accept
  a second ago and are looking at the job. Being texted about your own action is
  the noise this table was trimmed to remove. What they are told later is that
  the order is READY, which is the one thing that happens without them.
- The Partner is never sent a customer's name or phone number by SMS in any
  message. Both are on the dashboard, gated on this Partner still being the
  assigned one — and an SMS outlives that gate.
- `DELIVERY_AVAILABLE` goes to every available Partner and therefore carries
  nothing about anybody: no customer, no destination, no name, no amount owed to
  a named person. Its whole job is to get somebody to open their own dashboard.

`lib/orders/notify.js` derives the first name with `firstNameOf()`, which falls
back to the first word of a legacy `full_name` for accounts created before the
name was split.
