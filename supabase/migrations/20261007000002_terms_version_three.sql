-- ============================================================================
-- Terms, version 3: what Campus Dash does now
-- ============================================================================
-- Version 2 had fallen behind the product in ways a reader would act on:
--
--   - it told customers the Partner could see their Meal Scan (they no longer
--     can: the store checks it before a Partner is even looked for);
--   - it said a refused Meal Scan went to review "before anything else
--     happens" (a refused scan now ends the order);
--   - it had one free-text note; there are now two, for two readers: Order
--     information for the store, and Additional information for the Partner;
--   - it described store payouts as "as the customer pays" (Paystack settles a
--     store's money to its mobile money on the next working day).
--
-- Published as NEW ROWS, never an edit of version 2: an acceptance points at
-- the exact row somebody agreed to. Publishing makes version 3 outstanding for
-- the people it applies to, and they are asked to accept it on their next
-- visit — the mechanism working as designed (my_outstanding_terms()).
--
-- Still deliberately silent where the business has not decided
-- (docs/PILOT-QUESTIONS.md): what happens to food when a customer is absent,
-- and whether a Partner fee is returned when a customer collects instead.
--
-- FORMAT. Plain text. "## " starts a section, "- " a list item; /terms renders
-- those and nothing else.
-- ============================================================================

insert into public.terms_documents (audience, version, title, body, published_at)
values
  ('CUSTOMER', 3, 'Campus Dash customer terms',
   E'Campus Dash lets you order from stores around Academic City University and either collect your order yourself or have a Campus Dash Partner bring it to you on campus. These terms apply whenever you order.\n\n'
   '## Your account\n'
   'Customer accounts are for Academic City students and staff. You sign in with a code sent to your @acity.edu.gh address. One person, one account. The same account can also carry orders as a Partner or run a store.\n'
   'Keep your phone number accurate. It is how a Partner reaches you when they arrive.\n\n'
   '## Ordering\n'
   'Stores set their own prices and decide what is available. You order from one store at a time. At checkout you choose to collect it yourself or to have a Campus Dash Partner bring it to you, and you see the full price before you pay.\n'
   'You can add order information for the store, such as "no pepper". It is sent with your order and cannot be changed after you pay.\n'
   'If a Partner is bringing it, you choose where on campus from the list. A hostel on its own means its entrance. A building or a floor is enough; a room is optional. You can also add additional information for your Partner, such as "I am near the stairs, call when you arrive".\n\n'
   '## Prices and fees\n'
   'Your total can include:\n'
   '- the food, at the store''s price\n'
   '- a Campus Dash service fee, shown as its own line: a percentage of the food price, or a flat fee on a Meal Scan order\n'
   '- the Campus Dash Partner fee, only if a Partner brings your order\n'
   '- a pack fee on a Meal Scan order, when a pack is included\n'
   'What you see at checkout is what you are charged. A later price change never changes an order you have already placed.\n\n'
   '## Payment\n'
   'You pay once, through Paystack, before the store sees your order. An order is only confirmed when Paystack confirms the payment to us. Coming back to Campus Dash from the payment page does not, on its own, confirm anything.\n'
   'Until you pay, you can change how you get it or abandon the order. Nothing is charged for an order you abandon.\n\n'
   '## Meal Scan orders\n'
   'If a store accepts Meal Scans, you can pay for eligible items with your campus meal scan instead. The food is settled between you and the university, not by Campus Dash. You pay Campus Dash a flat service fee, the pack fee when a pack is included, and the Partner fee if a Partner brings it. A pack is optional when you collect and always included with a Partner.\n'
   'The store checks your scan before preparing anything. If the store cannot accept it, the order is cancelled and you can place a new one. Upload only a scan that belongs to you. It is seen by you, the store and Campus Dash administrators, never by a Partner.\n\n'
   '## Preparation and collection\n'
   'Once your payment is confirmed, the store starts on your order. There is no separate step where the store accepts it. When the food is ready, the store marks it ready and you are told.\n'
   'When you collect, the store reads you a 4-digit code at the counter. Enter it in Campus Dash to confirm you have your order.\n'
   'When a Partner brings it, Campus Dash shows you a 4-digit code. Read it to your Partner only once your order is in your hands.\n'
   'Too many wrong codes locks the code for a few minutes, for everybody, to stop guessing.\n\n'
   '## Where you are\n'
   'The place you choose is where your Partner comes. It cannot be changed once you have paid, and Campus Dash does not track your location. If you move, call your Partner. Their number is on your order while they are carrying it.\n'
   'If your Partner cannot reach you after waiting, they may record that you were not there, and Campus Dash will review what happens next.\n\n'
   '## Cancellations and refunds\n'
   'You cannot cancel an order once it is paid, and it is not refunded because you changed your mind.\n'
   'A refund may apply when a paid order cannot be fulfilled, for example:\n'
   '- the store cannot make your order\n'
   '- your order never reached the store because of a problem on our side\n'
   '- you were charged more than once for the same order\n'
   'Refunds are not automatic. A person at Campus Dash reviews each case and, where a refund applies, returns what you paid for that order to your original payment method.\n'
   'If something is wrong or missing, report it from the order or call us.\n\n'
   '## What Campus Dash can and cannot do\n'
   'Campus Dash works on campus only. Stores open and close when they choose, and Partners are students and staff who are available when they are. A Partner is never guaranteed: if none is found in time, you can collect your order yourself.\n\n'
   '## Respect\n'
   'Partners are students and staff helping the campus community. Treat them, and the people at every store, with respect. Campus Dash may restrict or suspend an account that abuses the service or the people in it.\n\n'
   '## Your information\n'
   'A store sees what you ordered and your order information. It never sees your additional information, where your order is going or your phone number. Your Partner sees your first name, where you chose and your additional information, and your phone number only while they are carrying your order. A Partner never sees your order information or your Meal Scan. Nobody is shown your surname.\n\n'
   '## Contact\n'
   'Call Campus Dash on 0531275217 or 0594667183.\n\n'
   '## Changes\n'
   'When these terms change, we publish the new terms and ask you to accept them. What you accepted, and when, is recorded.',
   now()),

  ('VENDOR', 3, 'Campus Dash store terms',
   E'Your store stays your business. Campus Dash brings you orders that are already paid for and, when a customer asks, a Campus Dash Partner to carry them. These terms apply when you run a store on Campus Dash.\n\n'
   '## Your account and approval\n'
   'You sign in with a code sent to your phone number. Keep that number working. One account runs one store.\n'
   'A Campus Dash administrator reviews every store before it goes live, and may pause, restrict or suspend a store that does not keep to these terms.\n\n'
   '## Your store and menu\n'
   'You set your prices and choose what is available. Keep your menu accurate, mark items sold out when they are, and close the store when you are not taking orders.\n'
   'Your store photos must be your own and must show your store or what you sell.\n'
   'You are responsible for the food and goods you sell, for preparing them safely, and for any licence or permission your business needs.\n\n'
   '## Orders\n'
   'You only ever receive orders that have been paid for, so there is nothing to accept or reject. Start preparing when an order arrives, and mark it ready only when it is ready.\n'
   'Read the order information if the customer left any. It is their note about the food, such as "no pepper".\n'
   'When somebody comes to collect, read them the 4-digit code shown on the order, whether they are the customer or a Campus Dash Partner. Hand the order over only once they have entered it.\n'
   'If you cannot fulfil a paid order, tell Campus Dash straight away.\n\n'
   '## Meal Scan orders\n'
   'If your store accepts Meal Scans, you check each scan before preparing the food, and you only accept a scan you would accept at your counter. If you cannot accept it, say why: the order is cancelled. Campus Dash does not verify scans with the university.\n'
   'The food on a Meal Scan order is settled between the student and the university, not by Campus Dash. When a pack is included, the pack fee is yours and you pack the order in it.\n\n'
   '## Getting paid\n'
   'You receive the full price of the food you sell through Campus Dash, and the pack fee on Meal Scan orders that include one. Campus Dash takes no commission from your prices. The customer pays the Campus Dash service fee and any Partner fee on top.\n'
   'When you add your mobile money details under Getting paid, Campus Dash registers them with Paystack. From then on your share of each order is set aside for you by Paystack as the customer pays, and Paystack pays it into your account on the next working day. Weekends and Ghana public holidays are not working days, so sales from Friday to Sunday usually arrive on Monday morning. Campus Dash does not hold or send this money.\n'
   'Until your details are registered, Campus Dash settles what you are owed directly. Keep your payout details accurate.\n'
   'If an order is refunded because it could not be fulfilled, you are not owed that order, and an amount already paid to you for it may be recovered.\n\n'
   '## Customer information\n'
   'You see what was ordered and any order information. You do not see where an order is going, what the customer wrote for their Partner, or the customer''s phone number. Do not try to collect customers'' personal details through Campus Dash.\n\n'
   '## Contact\n'
   'Call Campus Dash on 0531275217 or 0594667183.\n\n'
   '## Changes\n'
   'When these terms change, we publish the new terms and ask you to accept them. What you accepted, and when, is recorded.',
   now()),

  ('PARTNER', 3, 'Campus Dash Partner terms',
   E'Campus Dash Partners are students and staff who carry orders across campus, help the campus community and earn for doing it. These terms apply when you carry orders as a Partner.\n\n'
   '## Becoming a Partner\n'
   'You apply from your customer account with a photo of your student or staff ID. A Campus Dash administrator reviews every application. Being a Partner is part of your one Campus Dash account, not a separate one.\n'
   'You are an independent Partner, not an employee of Campus Dash or of any store. You choose when you are available and which orders you take.\n\n'
   '## Taking and carrying orders\n'
   'Before you take an order, you see the store, the part of campus it is going to, and what you earn. Once you take it, you also see the exact place the customer chose, their first name, any additional information they left for you, and their phone number.\n'
   'You may carry more than one order at a time, up to the limit Campus Dash sets. You cannot carry your own order, or an order from a store you own.\n'
   'Collect only once the store has marked the order ready. At the store, enter the 4-digit code the store reads out to you. At the destination, enter the 4-digit code the customer reads out to you. Never ask a customer for their code before they have their order.\n'
   'If the customer has moved, call them. If you cannot find them, wait for the time shown in the app and try to call before recording that they were not there.\n'
   'If you cannot finish an order you have taken, release it in the app as early as you can so another Partner can take it.\n\n'
   '## Customer information\n'
   'A customer''s phone number is shown to you only while you are carrying their order, and only so you can reach them about it. Do not save it, share it or use it for anything else. You never see a customer''s Meal Scan.\n\n'
   '## Earnings\n'
   'You earn the Campus Dash Partner fee, currently GH₵5, for each order you complete.\n'
   'Earnings are paid weekly to your mobile money account once your available balance reaches GH₵20. A smaller balance carries forward to the next week. Keep your payout details accurate.\n\n'
   '## Conduct\n'
   'Handle every order with care, keep food sealed, and treat customers and store staff with respect. Customers may rate completed deliveries. Campus Dash may restrict or suspend a Partner who does not keep to these terms.\n\n'
   '## Contact\n'
   'Call Campus Dash on 0531275217 or 0594667183.\n\n'
   '## Changes\n'
   'When these terms change, we publish the new terms and ask you to accept them. What you accepted, and when, is recorded.',
   now())
on conflict (audience, version) do nothing;
