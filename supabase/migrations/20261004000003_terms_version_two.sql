-- ============================================================================
-- Terms, version 2: real text for customers, stores and Partners
-- ============================================================================
-- Version 1 of each document was placeholder text. This publishes version 2 as
-- NEW ROWS, never an edit of version 1: an acceptance points at the exact row
-- somebody agreed to, and rewriting that row would rewrite what they agreed.
-- Publishing a new version makes it outstanding again for the people it applies
-- to, which is the mechanism working as designed (see my_outstanding_terms()).
--
-- WRITTEN AGAINST WHAT THE PRODUCT ACTUALLY DOES, and deliberately silent where
-- the business has not decided (docs/PILOT-QUESTIONS.md): what happens to food
-- when a customer is absent, and whether a Partner fee is returned when a
-- customer collects instead, are left to review rather than promised here.
--
-- The one refund rule that IS decided is stated plainly: a paid order is not
-- cancelled or refunded because somebody changed their mind. Refunds are made
-- by Campus Dash, after review, where an order could not be fulfilled.
--
-- FORMAT. Plain text. A line starting "## " is a section heading and a line
-- starting "- " is a list item; /terms renders those and nothing else, so the
-- text reads correctly anywhere it is shown raw.
-- ============================================================================

insert into public.terms_documents (audience, version, title, body, published_at)
values
  ('CUSTOMER', 2, 'Campus Dash customer terms',
   E'These terms apply when you order through Campus Dash. Campus Dash connects you with independent stores around Academic City University and, if you ask, with a Campus Dash Partner who brings your order to you.\n\n'
   '## Your account\n'
   'Customer accounts are for Academic City students and staff. You sign in with a code sent to your @acity.edu.gh address. Keep your details accurate, especially your phone number: it is how a Partner reaches you when they arrive.\n'
   'One person, one account. You may also run a store or become a Partner on the same account.\n\n'
   '## Ordering and prices\n'
   'Stores set their own prices and decide what is available. At checkout you choose to collect the order yourself or to have a Campus Dash Partner bring it to a campus location you pick from the list.\n'
   'Before you pay you see the full price:\n'
   '- the food, at the store''s price\n'
   '- a Campus Dash service fee, shown as its own line\n'
   '- the Campus Dash Partner fee, only if you choose a Partner\n'
   'What you see at checkout is what you are charged. A later price change never changes an order you have already placed.\n\n'
   '## Payment\n'
   'You pay once, through our payment provider, before the store sees your order. An order is only confirmed when the payment provider confirms the payment to us. Returning to Campus Dash from the payment page is not, on its own, confirmation.\n'
   'Until you pay, you can abandon an order from its page. Nothing is charged for an order you abandon.\n\n'
   '## Meal scans\n'
   'If a store accepts meal scans, you can pay for eligible items with your campus meal scan. The scan is settled between you and the university, not by Campus Dash. You pay Campus Dash a flat service fee, a pack fee when a pack is added, and the Partner fee if you choose a Partner. A pack is optional when you collect and included when a Partner brings your order.\n'
   'The store checks your scan before preparing your food. If the store does not accept it, Campus Dash reviews the order before anything else happens.\n'
   'Upload only a scan that belongs to you. It is visible to you, the store preparing the order, the Partner carrying it (while they carry it) and Campus Dash administrators.\n\n'
   '## Collecting and receiving your order\n'
   'When you collect, the store gives you a 4-digit code at the counter. Enter it in Campus Dash to confirm you have your order.\n'
   'When a Partner brings your order, Campus Dash shows you a 4-digit code. Read it to your Partner only once you have your order. Never share it before then.\n'
   'Be at the location you chose and reachable on your phone. If a Partner cannot reach you after waiting, they may record that you were not there, and Campus Dash will review what happens next.\n\n'
   '## Cancellations and refunds\n'
   'Once your payment succeeds, the store starts on your order. You cannot cancel a paid order, and it is not refunded because you changed your mind.\n'
   'A refund may apply when a paid order cannot be fulfilled, for example:\n'
   '- the store cannot make your order\n'
   '- your order never reached the store because of a problem on our side\n'
   '- you were charged more than once for the same order\n'
   'Refunds are not automatic. Campus Dash reviews each case and, where a refund applies, returns the amount you paid for that order to your original payment method.\n'
   'If something is wrong or missing, or a delivery did not happen as it should, report it from the order or contact us. Reports are reviewed by a person.\n\n'
   '## Respect\n'
   'Partners are students and staff helping the campus community. Treat them, and the people working at stores, with respect. Campus Dash may suspend accounts that abuse the service or the people in it.\n\n'
   '## Your information\n'
   'A store sees what you ordered, never where it is going or your phone number. Your Partner sees your first name, destination and phone number only while they are carrying your order. Nobody sees your surname.\n\n'
   '## Contact\n'
   'Call Campus Dash on 0531275217 or 0594667183.\n\n'
   '## Changes\n'
   'When these terms change, we publish a new version and ask you to accept it. The version you accepted, and when, is recorded.',
   now()),

  ('VENDOR', 2, 'Campus Dash store terms',
   E'These terms apply when you run a store on Campus Dash. Your store stays your business: Campus Dash brings you orders that are already paid for and, when a customer asks, a Campus Dash Partner to carry them.\n\n'
   '## Your account and approval\n'
   'You sign in with a code sent to your phone number. Keep that number working. It is how you sign in and how we reach you.\n'
   'A Campus Dash administrator reviews every store before it goes live, and may pause or suspend a store that does not keep to these terms.\n\n'
   '## Your store and menu\n'
   'You set your prices and choose what is available. Keep your menu accurate: mark items sold out when they are, and close the store when you are not taking orders.\n'
   'Your store photos must be your own, and must show your store or what you sell.\n'
   'You are responsible for the food and goods you sell, for preparing them safely, and for any licence or permission your business needs.\n\n'
   '## Orders\n'
   'You only ever receive orders that have been paid for. Start preparing when an order arrives, and press Ready for pickup only when it is ready.\n'
   'When somebody comes to collect, read them the 4-digit code shown on the order. Do not hand an order over to anyone who has not been given that code by you, whether they are the customer or a Campus Dash Partner.\n'
   'If you cannot fulfil a paid order, tell Campus Dash straight away.\n\n'
   '## Meal scans\n'
   'If your store accepts meal scans, you are the one who checks each scan before preparing the food, and you only accept scans you would accept at your counter. Campus Dash does not verify scans with the university.\n'
   'The food on a scan order is settled between the student and the university, not by Campus Dash. When a pack is included, the pack fee is yours and you pack the order in it.\n\n'
   '## Getting paid\n'
   'You receive the full price of the food you sell through Campus Dash, and the pack fee on scan orders that include a pack. Campus Dash does not take a commission from your prices. The customer pays the Campus Dash service fee and any Partner fee on top.\n'
   'Payments reach you by mobile money, either as the customer pays or in a regular settlement run, depending on how your payout account is set up. Keep your payout details accurate.\n'
   'If an order is refunded because it could not be fulfilled, you are not owed that order, and an amount already paid to you for it may be recovered.\n\n'
   '## Customer information\n'
   'You see what was ordered. You do not see where an order is going or the customer''s phone number. Do not try to collect customers'' personal details through Campus Dash orders.\n\n'
   '## Contact\n'
   'Call Campus Dash on 0531275217 or 0594667183.\n\n'
   '## Changes\n'
   'When these terms change, we publish a new version and ask you to accept it. The version you accepted, and when, is recorded.',
   now()),

  ('PARTNER', 2, 'Campus Dash Partner terms',
   E'These terms apply when you carry orders as a Campus Dash Partner. Partners are students and staff who help the campus community and earn for doing it.\n\n'
   '## Becoming a Partner\n'
   'You apply from your customer account with your student or staff ID. A Campus Dash administrator reviews every application. Being a Partner is part of your one Campus Dash account, not a separate one.\n'
   'You are an independent Partner, not an employee of Campus Dash or of any store. You choose when you are available and which orders you accept.\n\n'
   '## Accepting and carrying orders\n'
   'Before you accept, you see the store, the building and floor the order is going to, and what you earn. After you accept, you also see the room, the customer''s first name, any note they left, and their phone number.\n'
   'You may carry more than one order at a time, up to the limit Campus Dash sets.\n'
   'You cannot carry your own order, or an order from a store you own.\n'
   'At the store, enter the 4-digit code the store reads out to you. At the destination, enter the 4-digit code the customer reads out to you. Never ask a customer for their code before they have their order.\n'
   'If the customer is not there, wait for the time shown in the app and try to call them before recording that they were not there.\n'
   'If you cannot complete an order you have accepted, release it in the app as early as you can so another Partner can take it.\n\n'
   '## Customer information\n'
   'A customer''s phone number is shown to you only while you are carrying their order, and only so you can reach them about it. Do not save it, share it, or use it for anything else.\n\n'
   '## Earnings\n'
   'You earn the Campus Dash Partner fee, currently GH₵5, for each order you complete.\n'
   'Earnings are paid weekly to your mobile money account once your available balance reaches GH₵20. A smaller balance carries forward to the next week. Keep your payout details accurate.\n\n'
   '## Conduct\n'
   'Handle every order with care, keep food sealed, and treat customers and store staff with respect. Customers may rate completed deliveries. Campus Dash may suspend a Partner who does not keep to these terms.\n\n'
   '## Contact\n'
   'Call Campus Dash on 0531275217 or 0594667183.\n\n'
   '## Changes\n'
   'When these terms change, we publish a new version and ask you to accept it. The version you accepted, and when, is recorded.',
   now())
on conflict (audience, version) do nothing;
