# Paystack

The provider question in `docs/PILOT-QUESTIONS.md` is answered: **Paystack**,
hosted redirect checkout, GHS, one transaction per order. Read `docs/MONEY.md`
first — this document is only about the adapter and what it needs from the
outside world.

Everything Paystack-specific lives in `lib/payments/paystack.js`. Nothing else
in the codebase knows that a `reference`, an `authorization_url` or a
`transfer_code` exists.

## Environment

| Variable                     | Where           | Notes                                                                      |
| ---------------------------- | --------------- | -------------------------------------------------------------------------- |
| `PAYMENT_PROVIDER`           | required        | `fake` or `paystack`. Defaults to `fake` — the keys alone change nothing.  |
| `PAYSTACK_SECRET_KEY`        | **SERVER ONLY** | Charges, transfers, **and webhook signing**. See below.                    |
| `PAYSTACK_PUBLIC_KEY`        | server only     | Not used on the payment path. Server-only deliberately.                    |
| `PUBLIC_APP_URL`             | required        | Builds the checkout return URL. Without it the dashboard callback is used. |
| `PAYSTACK_API_URL`           | optional        | Defaults to `https://api.paystack.co`. For a proxy.                        |
| `PAYSTACK_TRANSFERS_ENABLED` | optional        | Defaults to **false**. Money out stays shut until a person opens it.       |

`process.env` is read only in `lib/config.js`, and the secret key goes through
`serverOnly()`, which throws rather than returning if browser code ever reaches
for it. `tests/secrets.test.js` asserts both, and asserts the built client
bundle contains neither the names nor the values.

### Why the public key is server-only too

It is not a secret. But hosted redirect checkout means **the browser never talks
to Paystack**: the server calls `/transaction/initialize` and sends the customer
to the URL it gets back. So nothing client-side needs a Paystack key at all. A
`NEXT_PUBLIC_PAYSTACK_PUBLIC_KEY` would inline a credential into every page for
no reason and invite an inline-checkout path that skips the server. If you ever
want Inline JS, that is a deliberate decision to make then, not a default to
drift into.

### The secret key is the webhook signing key

Paystack signs webhooks with HMAC-SHA512 keyed by the **secret key itself**.
There is no separate webhook secret. That makes the key more dangerous than it
first looks: anyone holding it can not only charge cards and send transfers, but
also **forge an event that marks an order paid**.

## Money in

```
customer taps Pay
   → startPayment()            creates the payment row (idempotent)
   → /transaction/initialize   reference = OUR payment id
   → authorization_url         stored on the payment AND returned
   → browser navigates to Paystack
   → customer pays
   → /payment/callback         browser comes back
   → provider.getStatus()      server-to-server verify
   → confirm_payment()         only if the PROVIDER says success
```

**The browser coming back is not proof of payment.** `/payment/callback` is an
unauthenticated GET that anyone can type, and an abandoned checkout redirects
there exactly like a completed one. So it decides nothing: it asks Paystack,
server to server, what actually happened. The signed webhook does the same from
the other direction, and whichever arrives first wins — `confirm_payment` is
idempotent.

Three independent paths can confirm a payment, which is deliberate: the webhook,
the browser return, and the order screen's polling. Any one of them being
blocked, late or lost still gets the customer an answer.

### Amounts

Paystack takes and reports GHS amounts in the **minor unit, which is the
pesewa**. So the integer crosses the boundary unchanged — no scaling, no
division, no float. The only guard that matters is currency: a non-GHS
transaction reports a `null` amount, which makes `confirm_payment` raise a
mismatch rather than accept a number that is right as an integer and wrong as
money.

### Idempotency

Paystack has no idempotency-key header. Its `reference` is the anchor, and it
refuses a reference it has already seen. We pass **our payment id** as the
reference, and `create_payment_intent` already makes that idempotent — so two
taps are one Paystack transaction. A duplicate-reference rejection is therefore
not an error: the adapter reads the existing transaction instead of opening a
second one.

The `authorization_url` is stored on the payment row, so a customer who
backgrounds the tab and comes back is sent to the **same** checkout.

### Customer email

`/transaction/initialize` will not open a checkout without an email address.
Campus Dash customers sign in by phone OTP and most have never given us one, so
it is asked for — on `/account`, and at the pay button if it is still missing.

**It is never synthesised.** A generated `<uuid>@campusdash.invalid` would send
every Paystack receipt into a hole and put a fiction in our own records. This is
not a verification step: no domain is required, no document, no photograph, and
the Partner application's own stricter requirements are untouched.

## Webhooks

`POST /api/payments/webhook/paystack`

0. The `[provider]` path segment must name the adapter this deployment actually
   serves, and the fake adapter is refused outright in production. Both are
   checked **before the body is parsed** — see below.
1. The raw bytes are hashed — HMAC-SHA512, keyed by the secret key — and
   compared against `x-paystack-signature` in constant time. Re-serialising the
   parsed body would change the whitespace and fail every time, which is why the
   route reads `request.text()`.
2. The event is **recorded**, deduplicating on `(provider, event_id)`.
3. Only then is it acted on.

### The path segment is checked, and the fake adapter is not a production adapter

The route used to ignore `[provider]` and hand the payload to whichever adapter
`PAYMENT_PROVIDER` selected. The serious half of that was the fake adapter,
whose "signature" is the literal header `x-fake-signature: fake-signature` —
anyone can send it. A production deployment left on `fake` therefore had an
effectively **unauthenticated** endpoint that can mark orders paid and payouts
`PAID`.

`providerGuard()` in `lib/payments/webhook.js` now answers, in this order:

| Situation                                              | Answer                             |
| ------------------------------------------------------ | ---------------------------------- |
| `PAYMENT_PROVIDER` unknown or unbuildable              | **503** — ours to fix; retry later |
| `config.isProduction()` and the provider is `fake`     | **503**, and a loud server log     |
| the path segment is not the configured provider's name | **404** — this route is not served |
| everything matches                                     | on to the signature check          |

The 404 deliberately does not say which provider _is_ configured. Nothing is
recorded on either refusal: a request for a provider this deployment does not
serve gets nowhere near the payload.

Local development is untouched — `PAYMENT_PROVIDER=fake` with the path `/fake`
behaves exactly as it did, and the in-process poller that simulates the fake
provider calling back names the adapter it just resolved.

Paystack sends no event id of its own, so the adapter derives one:
`` `${event}:${data.id}` `` — for example `charge.success:4001`. That pair is
stable across the retries Paystack makes, and it keeps a charge and a transfer
that happen to share a numeric id apart.

An invalid signature is **stored and flagged**, then rejected with 401. Someone
probing the endpoint leaves a trail rather than a 500.

### Collection events and transfer events are different ledgers

`charge.*` moves a **payment**. `transfer.*` moves a **payout**. They are
unrelated tables, and a transfer event never reaches `confirmPayment()` — the
kind is decided in the adapter from the event name, before anything is looked
up. Sending one down the other's path would either raise or, far worse, confirm
a payment against an id that happens to exist.

A transfer event for a payout we have no record of is recorded and ignored, not
500'd — otherwise Paystack would retry it forever.

## Split settlement — the vendor's share, routed at the charge

A vendor is entitled to 100% of the food subtotal. Until now that money landed
in the Campus Dash balance and was pushed back out by a daily payout run, which
meant a vendor waited a day for money that was never really ours.

It no longer has to. Paystack supports **dynamic splits**: a `split` object
passed inline on `/transaction/initialize`, dividing one charge between the main
account and one or more subaccounts, with no split group registered in advance.

### What Campus Dash sends

```json
{
  "email": "ama@acity.edu.gh",
  "amount": 4200,
  "currency": "GHS",
  "reference": "<our payment id>",
  "split": {
    "type": "flat",
    "currency": "GHS",
    "bearer_type": "account",
    "subaccounts": [{ "subaccount": "ACCT_…", "share": 3500 }]
  }
}
```

Every part of that is a decision:

**`type: "flat"`, not `"percentage"`.** The vendor is owed the food subtotal to
the pesewa. A percentage of a total that also contains a 5% service fee and a
GH₵5 delivery fee is not that number — it is a number that happens to be close
to it and drifts as the fees change.

**`share` is in pesewas, unscaled.** Paystack's minor unit for GHS _is_ the
pesewa, which is the unit this codebase already uses. Nothing is converted, and
no float appears.

**`bearer_type: "account"`.** Paystack's processing fee stays with Campus Dash.
The vendor gets 100% of the food; taking the fee out of their share would
quietly make that untrue.

**One subaccount, and it is always the vendor.** See the limitation below.

### The subaccount

A Ghana subaccount is created once per payout destination, from the same mobile
money details a transfer recipient uses:

```
POST /subaccount
{ "business_name": "Muni Kitchen", "settlement_bank": "MTN",
  "account_number": "0551234567", "percentage_charge": 0 }
```

`percentage_charge: 0` is the **fail-safe**, not an oversight. It is the default
share Paystack applies when a transaction names the subaccount with no explicit
split, and Campus Dash always sends one. If a split were ever omitted by
mistake, 0 leaves the money in our balance where it can still be sent on. A
default of 100 would send the whole charge — service fee, delivery fee and all —
straight to the vendor, and Paystack cannot pull that back.

### What the ledger records

`allocations.settlement_channel` says how each row's money reaches its payee:

| Channel    | Meaning                                                             |
| ---------- | ------------------------------------------------------------------- |
| `SPLIT`    | Paystack routed it at the charge. Born `SETTLED`; no run claims it. |
| `TRANSFER` | It is in the Campus Dash balance and a settlement run moves it.     |
| `NULL`     | Written before split settlement existed. Historical, not guessed.   |

`create_order_allocations()` reads what the payment ACTUALLY split — from
`payments.split_subaccount_code` and `payments.split_vendor_pesewas` — not what
was intended. A vendor who registered a subaccount after an order was charged is
still owed that order's money through a run.

### The limitations, stated plainly

**1. The Partner cannot be in the split.** The split is fixed when the charge is
created. At that moment the order has been accepted and priced and **no Partner
exists**: dispatch does not open until the vendor marks the food READY, which is
after payment. Paystack has no supported way to add a subaccount to a
transaction that has already been charged, and delaying payment until after
assignment would break the order architecture — the customer pays before the
kitchen starts.

So the Partner's GH₵5 stays in the Campus Dash balance at charge time, is carved
out of the platform allocation when they complete the delivery, and is settled
through Paystack Transfers, which is itself an officially supported mechanism
and stays gated behind `PAYSTACK_TRANSFERS_ENABLED`.

**2. A split cannot be reversed.** Money released to a subaccount cannot be
pulled back. A refund on a split order comes out of the Campus Dash balance, and
`/admin/orders/[id]` shows the split so nobody discovers this during a
reconciliation.

**3. A split can be refused, and must not stop the payment.** A deactivated
subaccount, or an account without multi-split enabled, makes Paystack reject the
whole initialisation. The adapter drops the split and retries once; the customer
buys their lunch, `splitApplied` comes back false, no split is recorded, and the
vendor's money is settled by the run exactly as before. A customer must never be
unable to eat because of a settlement arrangement they are not party to.

**4. `PAYSTACK_SPLIT_ENABLED` can turn it off** for an account where multi-split
is not enabled, rather than logging a refusal on every order.

### Where the details are entered

A vendor sets their own at `/vendor/profile` → **Getting paid**, which calls
`vendor_set_payout_destination()` and then registers the subaccount. Saving the
number and registering it are separate steps, and the second is allowed to fail:
the number is what the vendor asked to save, and Paystack being unreachable must
not lose it. An administrator sees who is set up at `/admin/settlements` →
**Payout setup**, with a button to retry a failed registration.

Changing a number or a network **clears both provider codes** — the recipient
and the subaccount — so neither a transfer nor a split can keep paying the old
account.

## Money out

Vendor daily and Partner weekly settlement are unchanged. Paystack simply sits
behind the same `PaymentProvider` interface.

What did change is the lifecycle, because **provider acceptance is not
delivery** (hard rule 15):

```
PENDING  ──(Paystack accepted the transfer)──▶  PROCESSING
PROCESSING ──(transfer.success)──▶  PAID       allocations SETTLED
PROCESSING ──(transfer.failed)──▶   FAILED     allocations RELEASED
```

A failed transfer releases the allocation claim: the allocations go back to
`ELIGIBLE` and unclaimed, so the money is swept into the next run rather than
stranded behind a dead payout row. The payout stays `FAILED` for a person to
look at.

**Retry is manual, always.** Nothing retries a transfer on its own — an
automatic loop against a payments API is how the same money gets sent twice.
`retry_payout()` re-claims the released allocations first, and **refuses** if a
later run has already swept them, because paying an amount that no longer
matches what is owed is worse than not paying yet.

### Payout destinations

A phone number is not enough to send mobile money. Paystack needs a network (its
"bank code"), an account number and a name, and it issues a `recipient_code`
that later transfers refer to.

Those live in `public.payout_destinations` — **a server-only table with no
grants for any client role**, like `order_secrets`. They are deliberately not on
`vendors`, where `vendors_read_active` lets any anonymous visitor select every
column of an active vendor.

| Ours         | Paystack | Network                     |
| ------------ | -------- | --------------------------- |
| `MTN`        | `MTN`    | MTN Mobile Money            |
| `VODAFONE`   | `VOD`    | Telecel (formerly Vodafone) |
| `AIRTELTIGO` | `ATL`    | AirtelTigo Money            |

Set one at `/admin/settlements`; a Partner keeps their own current through
`partner_set_payout_destination()` and a vendor through
`vendor_set_payout_destination()`. Changing the number or the network **clears
both the recipient code and the subaccount code**, so neither a transfer nor a
split can keep paying the old account.

Neither `my_payout_destination()` nor `admin_payout_readiness()` returns a whole
account number — the last three digits are enough to recognise your own, and a
screen that echoes the rest is a screen that leaks it over a shoulder.

### Transfers are off by default

`PAYSTACK_TRANSFERS_ENABLED` defaults to false and stays false until somebody
turns it on. Collection is safe to enable the moment the keys exist — the worst
case is a test charge. Transfers are not: they need a funded balance, transfers
approved on the Paystack account, and destinations a person has actually
checked.

While it is off, `sendTransfer()` refuses **before any Paystack call** — so no
recipient is registered either — settlement records the payout `FAILED` with the
reason, and the allocation goes back into the next run. Nothing is silently
lost.

## Testing

`npm test` never touches Paystack. `tests/paystack.test.js` runs the real
adapter against a stub `fetch`, which is the only way to assert what it does
with a mismatched currency or a duplicate reference. The signature maths is not
stubbed — a signature check that passes only against its own implementation
checks nothing. `tests/paystack-payouts.test.js` covers the payout lifecycle,
the email, and the destinations against the database.

For a real TEST-mode call:

```
npm run paystack:test              # GH₵1.00 to a placeholder address
npm run paystack:test -- 250 you@example.com
```

It opens one real hosted checkout and verifies it back, proving the credential,
the adapter and the GHS pesewa round trip. It **refuses to run against a live
key**, and it writes nothing to our database.

## Going live

1. Swap `PAYSTACK_SECRET_KEY` / `PAYSTACK_PUBLIC_KEY` for the `sk_live_` /
   `pk_live_` pair.
2. Set `PUBLIC_APP_URL` to the real origin.
3. Register `https://<origin>/api/payments/webhook/paystack` as the webhook URL
   on the Paystack dashboard.
4. Set `PAYMENT_PROVIDER=paystack`.
5. Leave `PAYSTACK_TRANSFERS_ENABLED` unset until the balance is funded,
   transfers are approved, and every payout destination has been checked against
   a real person.
