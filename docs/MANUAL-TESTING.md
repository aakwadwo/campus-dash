# Manual end-to-end testing

Everything here is **local development only**. The accounts, the passcodes and
the inbox page do not exist in a production build.

## Before you start

```bash
npm run db:start          # if Supabase is not already up
npm run db:reset          # migrations + seed, from empty
npm run seed:documents    # placeholder ID/selfie images for the Partner queue
npm run dev
```

`db:reset` wipes all orders. `seed:documents` must be re-run after every reset —
the document *paths* are seeded but the image *files* are not, and without them
the Partner approval screen has nothing to show.

## Signing in

Every account uses phone OTP. There are no passwords.

1. Go to **http://localhost:3000/login**
2. Enter the number below (the `020 …` form is what the field expects)
3. Open **http://localhost:3000/dev/inbox** in another tab and read the code
4. Type it in

The inbox holds the last 25 messages, newest first, in server memory only.
Restarting `npm run dev` clears it. It returns **404** in a production build and
whenever `SMS_PROVIDER` is not `fake` — see `tests/dev-inbox.test.js`.

Use a separate browser profile (or a private window) per role. They are separate
sessions, and signing in as the vendor in the same profile will sign the
customer out.

## Development accounts

| Role | Phone | Name | Where they land |
| --- | --- | --- | --- |
| Admin | `0200000001` | Dev Admin | `/admin` |
| Vendor — Test Kitchen One | `0200000011` | Muni Owner | `/vendor` |
| Vendor — Test Grill Two | `0200000012` | Grill Owner | `/vendor` |
| Customer | `0200000021` | Ama Test-Customer | `/order` |
| Customer | `0200000022` | Kwesi Test-Customer | `/order` |
| Partner (approved) | `0200000031` | Yaw Test-Partner | `/partner` |
| Partner (approved) | `0200000032` | Adjoa Test-Partner | `/partner` |
| Partner applicant | `0200000033` | Kofi Test-Applicant | `/partner/apply` |
| Partner applicant | `0200000035` | Kojo Test-Applicant | `/partner/apply` |

Customers `0200000023` / `0200000024` and Partner `0200000034` are spare.

## Timings

The seed widens three windows **for manual testing only**, because a human
switching between four browser profiles cannot beat the real ones:

| Setting | Seeded for manual use | Production intent |
| --- | --- | --- |
| Vendor answer window | 30 min | 60 s |
| Partner search window | 30 min | 10 min |
| Customer-absent wait | 60 s | 5 min |
| Payment timeout | 5 min | 15 min |

Change any of them live at `/admin/pilot`. The automated tests set their own
values and ignore these. To feel the real 60-second vendor window, set it at
`/admin/pilot` before placing the order.

## The full lifecycle

Prices: **10% Campus Dash fee** on the food, **GH₵5** flat delivery.
A Jollof (GH₵35) delivered costs GH₵35.00 + GH₵3.50 + GH₵5.00 = **GH₵43.50**.

1. **Customer** `/order` → Test Kitchen One → add items → Delivery → pick a room
   (Room 101/102/204/205) → place the order. Check the fee reads GH₵3.50 on a
   single Jollof.
2. **Payment** starts automatically and settles itself after ~2 seconds. Stay on
   the order page — the page poll is what delivers the fake provider's callback.
3. **Vendor** `/vendor` → the order is in **NEW** → Accept → Preparing → Ready.
4. **Partner** `/partner` → go online → `/partner/offers` → accept the delivery.
   A Partner may hold only one at a time; use a second Partner account to see an
   offer refused.
5. **Pickup** — the Partner reads their 4-digit pickup code at
   `/partner/delivery`; the **vendor** types it in on the order. The customer's
   room and phone appear to the Partner only now.
6. **Delivery** — the customer reads their delivery code at `/orders/[id]`; the
   **Partner** types it in. Order completes; both phone numbers disappear.
7. **Admin** `/admin/money` → the order splits vendor / Partner / platform and
   sums to the total. `/admin/settlements` → create a run and pay it out.

### Also worth walking

- **Partner approval** — Admin `/admin/partners` → Kofi Test-Applicant → the ID
  and selfie panels render placeholder images via short-lived signed URLs →
  approve or reject.
- **Pickup order** — no Partner, no delivery fee, vendor completes it directly.
- **Vendor rejection** and **letting the answer window expire**.
- **Item availability** — vendor marks an item unavailable; it disappears from
  the customer menu but placed orders keep their price.
- **Stuck payment** — restart `npm run dev` while a payment is pending. The
  fake provider's in-memory record is lost, so it hangs; after the payment
  timeout the customer can abandon it and retry, and a sweep runs every 15 min.
- **Pilot metrics** — `/admin/pilot`.

## Resetting

```bash
npm run db:reset && npm run seed:documents
```

`npm run seed:orders [count] [DELIVERY|PICKUP]` places orders without the UI.
