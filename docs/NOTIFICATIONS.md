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

| Event             | Customer            | Vendor        | Partner                     |
| ----------------- | ------------------- | ------------- | --------------------------- |
| Order submitted   | ✓                   | ✓             |                             |
| Vendor accepted   | ✓                   |               |                             |
| Vendor rejected   | ✓                   |               |                             |
| Payment confirmed | ✓                   | ✓             |                             |
| Preparing         | ✓                   |               |                             |
| Ready             | ✓                   |               |                             |
| Partner assigned  | ✓ _(delivery code)_ | ✓ _(no code)_ | ✓ _(pickup code, earnings)_ |
| Partner picked up | ✓                   |               | ✓ _(destination)_           |
| Delivered         | ✓                   |               | ✓ _(earning)_               |
| Cancelled         | ✓                   | ✓             | ✓                           |

**The vendor is never sent the pickup code.** A vendor who knew it could confirm
a handoff that never happened.

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
