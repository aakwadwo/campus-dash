# Pilot Operations

For whoever is watching Campus Dash while real students use it.

## Every morning

Open `/admin/pilot`. Three things matter:

1. **Reconciliation issues** and **failed payouts** — should both be zero.
   Anything else means money is not where we think it is.
2. **Messages that did not arrive** — should be empty. A customer who never got
   their delivery code cannot receive their food.
3. **The timing medians** — these are the pilot's actual output. Write them
   down; they are the answers to `docs/PILOT-QUESTIONS.md`.

## Every day

**Run the vendor settlement.** `/admin/settlements` → _Run vendor settlement_.
Safe to press twice: a run for a period already settled is returned, not
recreated, and nobody is paid twice.

## Every week

**Run the Partner payouts.** Same screen.

## When something is stuck

`/admin/orders` sorts by how much a human is needed. Problems first, oldest
first within each group.

| It says                   | What happened                           | What to do                                                                   |
| ------------------------- | --------------------------------------- | ---------------------------------------------------------------------------- |
| `DISPUTED`                | Customer reported a problem             | Read the order history, phone both sides, resolve with a reason              |
| `CUSTOMER_ABSENT`         | Partner waited and gave up              | Decide what happens to the food. The Partner has already been paid           |
| `NO_PARTNER`              | Nobody took it                          | The customer has been offered a choice. Chase a Partner, or let them collect |
| `PAYMENT_FAILED`          | Provider declined or timed out          | Nothing was taken. The customer can retry from their order screen            |
| `AWAITING_VENDOR` and old | The stall is not looking at their phone | Ring them. The order expires by itself                                       |
| `REFUND_PENDING`          | An order was cancelled after payment    | Refund at the provider, then _Mark refunded_                                 |

Every override needs a reason. It goes in `admin_actions` and cannot be edited
or deleted afterwards — including by you.

## Turning the knobs

`/admin/pilot` → _Pilot settings_. Blank means leave alone.

The two you will most likely change first:

- **Vendor answer window** if stalls keep timing out at lunchtime.
- **Partner search window** if customers sit on "Finding a Partner" too long.

A fee change applies to the **next** order. An order already placed keeps the
price it was quoted — that is deliberate and cannot be overridden.

## Approving Partners

`/admin/partners`. Compare the live face photograph with the student ID. That
comparison **is** the security control — the camera-only capture is a
deterrent, not proof.

Reject anything you are unsure about. A rejected applicant can re-apply.

## What runs by itself

| Job                                 | Every  | Does                                                                   |
| ----------------------------------- | ------ | ---------------------------------------------------------------------- |
| `campus-dash-expire-stale-orders`   | 30s    | Expires orders a vendor never answered. Nothing charged                |
| `campus-dash-expire-partner-search` | 1 min  | Marks a delivery `FAILED_NO_PARTNER`. **The food order is untouched**  |
| `campus-dash-expire-stale-payments` | 15 min | Fails payments the provider never confirmed, so the customer can retry |

Their health is on `/admin` — a scheduler that has silently stopped looks
exactly like an application bug.

## What is deliberately not automatic

**Settlement.** There are buttons, not a schedule. Running money on a timer
before anyone has watched it run by hand is the wrong order.

**Document deletion.** Retention deadlines are recorded and listed; deleting is
a deliberate act.

**Refunds.** The system records intent. Moving money is the provider's job, and
which provider is still open.

## If the pilot goes wrong

Close every vendor: `/admin/vendors` → each vendor → _SUSPENDED_. No new orders
can be submitted. Orders already in flight are unaffected — customers still get
fed, and Partners still get paid.
