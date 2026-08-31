# Pilot Questions

Things code cannot answer. Each one is a real decision with a real cost, and
guessing at a desk is how you get a system that works perfectly and nobody uses.

Where a question needed _something_ to exist, the safest reversible choice was
made and is noted. None of these are locked.

Last reviewed: 2026-09-06

---

## Pricing

**1. What service fee will students accept?**
Currently 10% of the food subtotal (`service_fee_bps = 1000`). A guess — and
being a percentage, it is the number that decides whether a GH₵80 group order
is worth placing.

**2. What delivery fee will Partners accept for a campus walk?**
Currently GH₵5.00, all of it to the Partner
(`partner_share_of_delivery_bps = 10000`). If Campus Dash is meant to take a
cut of delivery as well as the service fee, that number changes and nothing
else does.

**3. Should vendors pay commission?**
They do not. The vendor allocation is the full food subtotal.

_All three are editable at `/admin/pilot` without a deploy, and a change
applies to the NEXT order only — an order already placed keeps its snapshot._

---

## Timing — the assumptions most likely to be wrong

**4. How fast do vendors actually answer?**
60 seconds is assumed. A stall at lunchtime may need three minutes. If it is
wrong, orders expire constantly and students stop trying.
_Measured as `median_vendor_response_seconds`._

**5. How many Partners are online at peak?**
Unknown. If the answer is "none between lectures", `FAILED_NO_PARTNER` becomes
the normal case and the no-Partner screen becomes the main flow rather than an
edge case.
_Measured as `partners_online_now` and `deliveries_no_partner_found`._

**6. How long should a customer wait before being offered a choice?**
10 minutes is assumed.

**7. How long should a Partner wait for an absent customer?**
5 minutes is assumed. Too short and Partners abandon; too long and they refuse
the job.

---

## Operations

**8. What happens to the food when a customer is absent?**
**Decided so far:** the Partner is paid — they collected the order and
travelled. **Not decided:** what happens to the food, and whether the customer
is refunded the food, the delivery fee, both or neither. The system records the
event and hands it to an admin.
_This will happen in the first week._

**9. Who pays for wrong or missing items?**
Nothing automatic. A dispute records a claim and changes no money until an
admin resolves it. Deliberate: acting on assertions automatically is how a
system gets played.

**10. Vendor settlement timing?** Daily is assumed.

**11. Partner payout timing?** Weekly is assumed.

**12. Is the delivery fee refunded when a customer collects instead?**
Currently **no** — `customer_collect_instead()` does not refund, because a
partial refund depends on what the provider supports. The screen says so and
points at support.

---

## Providers

**13. Hubtel or Paystack?**
Open. Nothing depends on the answer: both a split-settlement provider and a
collect-then-transfer provider produce identical `payments`, `allocations`,
`settlement_runs` and `payouts` rows.

**14. Does the chosen provider support the collection/transfer model we need?**
Specifically: MoMo collection, programmatic transfers to vendor and Partner
numbers, partial refunds, webhook signing, and idempotency keys on both
directions.

**15. Which Ghana SMS provider?**
Open. Delivery already goes through `SmsProvider`; a real provider is one file.

**16. What is the real SMS bill?**
Every party is notified at several points. Measured as
`notifications_per_order` — the first week of real use will show which
messages are worth keeping.

---

## Legal and data protection — the actual launch blockers

**17. Terms and conditions.**
`terms_documents` holds three PLACEHOLDER documents, clearly marked as such.
The mechanism is complete: versioned, timestamped, per-audience, and a new
version re-prompts only the people it applies to.

Real text is needed before anyone outside the team uses Campus Dash, covering
at minimum: customer responsibility, vendor responsibility, **the Partner
contractor relationship**, wrong or missing orders, delivery disputes, customer
absence, refunds, payment, data protection, and student ID/selfie handling.

**Blocked on a lawyer, not on engineering.**

**18. What retention applies to student IDs and selfies?**
90 days after approval, 30 after rejection — both placeholders, both
configurable. `admin_partner_documents_due_for_purge()` lists what is due;
deletion is a deliberate admin act, not automatic.

**19. Data Protection Commission requirements?**
We hold phone numbers, government-adjacent ID photographs and live face
photographs of students. Registration obligations, lawful basis and subject
rights are all unaddressed.

**20. Partner contractor and liability structure?**
Partners are treated as independent. Whether that survives contact with
Ghanaian employment law is a question for counsel.

---

## Not questions — decisions already made

For the avoidance of re-litigating:

- Partner, never "runner".
- No maps, GPS, live tracking, ratings, reviews, chat, coupons or loyalty.
- One active delivery per Partner. This is enforced by a unique index, so
  allowing more is a **migration**, not a setting — which is why there is
  deliberately no config knob for it.
- Vendor registration is closed.
- Vendors never see a customer's phone number.
- The vendor accepts before the customer pays.
