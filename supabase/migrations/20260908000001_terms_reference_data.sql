-- ============================================================================
-- Terms documents are reference data, not seed data
-- ============================================================================
-- The three placeholder terms documents were only ever inserted by
-- supabase/seed.sql, which runs on a local `db:reset` and nowhere else. So a
-- real environment — the hosted project included — came up with an empty
-- terms_documents table.
--
-- Nothing errors when that happens, which is the problem. my_outstanding_terms()
-- returns no rows, every actor signs in with nothing to accept, and the whole
-- acceptance mechanism looks like it is working when it has simply been
-- skipped. A gate that silently opens is worse than no gate.
--
-- So the documents move here, alongside the pricing_config singleton: platform
-- reference data that every environment gets. The development seed keeps only
-- the ACCEPTANCES, which are genuinely development-only — they exist so a
-- local walkthrough does not start behind a wall.
--
-- THIS IS PLACEHOLDER TEXT AND NOT LEGAL ADVICE. Real terms must come from a
-- lawyer familiar with Ghanaian consumer and contractor law before anybody
-- relies on them — see docs/PILOT-QUESTIONS.md. Publishing real text is an
-- INSERT of version 2, never an edit of version 1: an acceptance points at the
-- exact row the person agreed to, and rewriting that row would rewrite what
-- they agreed.
-- ============================================================================

insert into public.terms_documents (audience, version, title, body, published_at)
values
  ('CUSTOMER', 1, 'Campus Dash customer terms (PLACEHOLDER)',
   E'PLACEHOLDER TEXT — NOT LEGAL ADVICE.\n\n'
   'You order from independent vendors around Academic City. Campus Dash takes '
   'payment, passes the food amount to the vendor, and arranges delivery by a '
   'verified student Partner when you ask for one.\n\n'
   'You are not charged until a vendor accepts your order. Prices are set by '
   'vendors. Campus Dash charges a service fee, and a delivery fee when a '
   'Partner brings your order.\n\n'
   'You will be given a delivery code. Give it only to the Partner who brings '
   'your order.', now()),

  ('VENDOR', 1, 'Campus Dash vendor terms (PLACEHOLDER)',
   E'PLACEHOLDER TEXT — NOT LEGAL ADVICE.\n\n'
   'You accept or reject orders within the response window shown in the app. '
   'Prices are yours; Campus Dash does not change them. You mark food READY '
   'only when it is actually ready.\n\n'
   'Campus Dash settles the food amount to you daily. Campus Dash does not hold '
   'your money as a balance.\n\n'
   'You verify a Partner''s pickup code before handing over any order.', now()),

  ('PARTNER', 1, 'Campus Dash Partner terms (PLACEHOLDER)',
   E'PLACEHOLDER TEXT — NOT LEGAL ADVICE.\n\n'
   'You are an independent student Partner, not an employee of Campus Dash.\n\n'
   'You carry one delivery at a time. You collect orders using the pickup code '
   'shown in your app and complete them using the code the customer gives you.\n\n'
   'Customer contact details are shown only while you are carrying their order, '
   'and must not be recorded, shared or used for anything else.\n\n'
   'Campus Dash pays Partner earnings weekly.', now())
on conflict (audience, version) do nothing;
