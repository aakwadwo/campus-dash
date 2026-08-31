# Vendor Module

One job: a real vendor, on a phone next to a hot plate, takes an order from
arrival to READY without having to understand anything else about the system.

## What a vendor does

```
New order arrives  ─── SMS + in-app alert + countdown
        │
     ACCEPT ──────────▶ customer is told to pay
        │                       │
        │                  payment lands
        │                       ▼
   START PREPARING ◀── only possible once payment_status = PAID
        │
    FOOD IS READY ────▶ delivery: dispatch opens, a Partner is sought
                        pickup:   customer is told to collect
```

That is the whole vendor mental model. **Accept → Prepare → Ready.** Partner
matching, payment collection, allocation and settlement all happen without them.

## What the vendor sees, and what they do not

The board and detail come from `vendor_order_board()` and
`vendor_order_detail()`, which decide exposure in the **database**. A page that
merely omitted a column would still have sent it over the wire.

| Shown                            | Withheld                        |
| -------------------------------- | ------------------------------- |
| Order number, items, quantities  | The customer's identity         |
| Snapshotted prices and the total | The customer's phone number     |
| Pickup, or delivery + **zone**   | The destination **room**        |
| Payment status                   | Pickup and delivery codes       |
| Order age and the 60s countdown  | Any other vendor's orders       |
| Whether a Partner is assigned    | Which Partner, or their details |

The destination zone (`Hostel Block A`) is enough for a vendor to picture the
job. The room is the Partner's business, not theirs.

## The four groups

Server-decided, via `vendor_order_bucket()`, so every screen agrees:

- **NEW** — SUBMITTED. Needs an answer, has a countdown, and is the only group
  that raises an alert.
- **PREPARING** — ACCEPTED or PREPARING.
- **READY** — cooked. For delivery, dispatch is open.
- **CLOSED** — completed, rejected, expired or cancelled. Capped at 20 so a busy
  stall does not scroll through last week.

Live work sorts **oldest first**: the order nearest its deadline leads.

## The new-order alert

Three signals, no push infrastructure:

1. **SMS** through the existing `SmsProvider` — the same seam every other
   notification uses.
2. **In-app banner** plus a count in the browser tab title.
3. **A short tone** when the pending count goes _up_, because a phone on a
   counter is not being watched.

The page polls `vendor_pending_count()` every 8 seconds. That function checks
`is_vendor_staff()` itself, so probing another vendor's id returns 0 rather than
a number that leaks how busy a competitor is.

## Things a vendor cannot do — and why they cannot

Not hidden buttons. There is no grant under which any of these could succeed:

| Cannot                                | Enforced by                                                             |
| ------------------------------------- | ----------------------------------------------------------------------- |
| Mark an order PAID                    | No UPDATE grant on `orders`; `confirm_payment` not granted to clients   |
| Change the price of a submitted order | No UPDATE grant on `orders` or `order_items`                            |
| Change what was ordered               | No INSERT/UPDATE/DELETE grant on `order_items`                          |
| Complete a delivery                   | `partner_complete_delivery` requires being the assigned Partner         |
| Assign a Partner                      | No UPDATE grant; `partner_accept_delivery` requires an approved Partner |
| Read a pickup or delivery code        | `order_secrets` has no policy and no grant for anyone                   |
| Touch another vendor's order          | Every function re-checks `is_vendor_staff()`                            |
| Change their own vendor status        | `admin_set_vendor_status` requires an admin                             |

A vendor **can** open and close their own stall. Closing stops new orders and
leaves orders already in flight completely alone — the customer still gets fed.

## Several people, one stall

Anyone in `vendor_users` for a stall sees the same board and can act on it.
Removing them cuts access off immediately, mid-shift.

When two colleagues tap ACCEPT at the same moment, one wins. The other is told
**"someone else already accepted this order"** — not a state machine error.
Getting that message right mattered: the failure branch re-reads the current
state, because the value captured before the race describes a world that no
longer exists.

## Deliberately not built

- **Partner handoff.** `vendor_confirm_pickup()` exists and is tested, but the
  screen for it belongs with the Partner delivery workflow.
- **Order history beyond today**, search, printing, and per-item availability
  from the vendor screen. None of these are needed to get food out.

`app/api/dev/orders` places test orders so this module could be exercised before
the customer UI exists. It returns 404 in production and is the only caller of
`submit_order_for()`, which is never granted to a client role.
