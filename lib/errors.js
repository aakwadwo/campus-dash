/**
 * Turning a failure into something a person can act on.
 *
 * Users must never see a stack trace, a SQL error, a constraint name or an
 * internal id. Developers must still be able to find the cause, so the detail
 * goes to the server log and only a plain sentence goes to the screen.
 *
 * The categories matter for tone as much as for HTTP status: losing a race is
 * routine and should read that way, while a genuine fault should not be dressed
 * up as the user's mistake.
 */
export const ERROR_KIND = Object.freeze({
  /** They can fix it themselves. */
  USER: 'USER',
  /** Someone else got there first, or the state moved on. Routine. */
  CONFLICT: 'CONFLICT',
  /** They are not allowed. Say so without confirming what exists. */
  FORBIDDEN: 'FORBIDDEN',
  /** A provider or the network. Trying again may work. */
  TEMPORARY: 'TEMPORARY',
  /** Ours. Nothing they can do. */
  INTERNAL: 'INTERNAL',
});

const HTTP_STATUS = {
  USER: 400,
  CONFLICT: 409,
  FORBIDDEN: 403,
  TEMPORARY: 503,
  INTERNAL: 500,
};

/**
 * Postgres error codes and phrases we raise on purpose, mapped to how they
 * should read. Anything not listed is treated as internal — the safe default,
 * because an unrecognised error is one whose text we have not vetted for
 * leaking internals.
 */
const PATTERNS = [
  {
    match:
      /insufficient_privilege|admin privileges required|not authorised|not approved|permission denied/i,
    kind: ERROR_KIND.FORBIDDEN,
    message: 'You do not have access to do that.',
  },

  // THE ADMIN DELETE REFUSALS, which are the safety rule working and not a
  // fault. admin_delete_vendor() and admin_delete_customer() refuse anything
  // carrying orders, settlement rows or ratings, and they say so in a sentence
  // written for a log. Unmapped, every one of them fell through to the internal
  // fallback, so a deliberate refusal read as "something went wrong on our
  // side" and the feature looked broken. The counts and the table names stay in
  // the log. What reaches the screen is the decision and the way out of it.
  //
  // MATCHED ON THE TAIL, NOT ON "cannot delete:". That prefix is also raised by
  // the menu item and location deletes, whose way out is "Disable it instead"
  // and "Deactivate it instead" rather than suspension. Answering those with
  // this sentence would be worse than leaving them alone.
  {
    match:
      /belong to this store|involve this account|(store|account) has settlement records|delivery ratings against it/i,
    kind: ERROR_KIND.CONFLICT,
    message:
      'That cannot be deleted because it has orders or money records associated with it. Suspend it instead.',
  },

  // Not a money refusal, so not the sentence above. The store is the thing in
  // the way, and removing it is something the admin can actually go and do.
  {
    match: /owns a store\. Delete the store first/i,
    kind: ERROR_KIND.CONFLICT,
    message: 'That account owns a store. Delete the store first.',
  },

  // Both administrator refusals, which are about the audit trail rather than
  // about orders: admin_actions keys off the administrator row.
  {
    match: /administrator account cannot be deleted|administrator cannot delete their own/i,
    kind: ERROR_KIND.CONFLICT,
    message: 'An administrator account cannot be deleted here.',
  },

  // EVERY audited admin function raises this, not only the deletes, so the
  // wording names the audit log rather than the act. Seven call sites share it.
  {
    match: /a reason is required/i,
    kind: ERROR_KIND.USER,
    message: 'Please give a reason. It is recorded in the audit log.',
  },

  // 'vendor not found' is already answered by the generic not-found line below
  // and is left there: a vendor runs a store, and calling one an account would
  // be wrong. This is the account half, which had no line at all.
  {
    match: /no such account/i,
    kind: ERROR_KIND.USER,
    message: 'We could not find that account.',
  },

  {
    match: /already been taken|already accepted|lock_not_available/i,
    kind: ERROR_KIND.CONFLICT,
    message: 'Someone else got there first.',
  },

  // THE UNIQUENESS RULES, said back WITHOUT confirming what already exists.
  //
  // complete_customer_onboarding() raises these deliberately and the database
  // behaviour behind them is unchanged: a phone number, an address and a student
  // ID each belong to one account, and a second account cannot take one. What
  // changed is what the person is told. These used to name the field and assert
  // that another Campus Dash account held it, which answers a question nobody
  // signing up is entitled to ask — type a number, read whether it is registered
  // — and it is the same answer whether that account is a customer's or a
  // store's. So the reply says the details could not be used and asks them to
  // check, which is the one thing they can act on either way.
  //
  // It is still a FAILURE, and it still reads as one. Nothing here turns a
  // refused sign-up into a success message; the account was not created and the
  // screen says so. The wording names no screen either, because the same
  // collision reaches update_my_profile() from the account settings form.
  {
    match:
      /student ID number is already registered|phone number is already used|email address is already used/i,
    kind: ERROR_KIND.CONFLICT,
    message: 'There is a problem with the details you entered. Check them and try again.',
  },

  // THE UPLOAD MESSAGES, which are ours and are already written for a person.
  // They are listed here for the same reason every other line is: this list is
  // what says a string has been READ and carries no provider text, no bucket
  // name and no path. Anything an upload throws that is not one of these falls
  // through to the generic sentence below.
  // A MEAL SCAN IS A PHOTOGRAPH, and the message says which two buttons to use
  // rather than listing media types at somebody standing in a queue. It comes
  // first because the generic image line below would otherwise swallow it.
  {
    match: /photo of your Meal Scan/i,
    kind: ERROR_KIND.USER,
    message: 'Your Meal Scan has to be a photo. Choose one from your photos, or take one.',
  },

  {
    match: /JPEG, PNG or WebP/i,
    kind: ERROR_KIND.USER,
    message: 'Please use a JPEG, PNG or WebP image.',
  },

  {
    match: /too large/i,
    kind: ERROR_KIND.USER,
    message: 'That file is too large. Please use one under 5 MB.',
  },

  {
    match: /Could not save that image|Could not save that scan/i,
    kind: ERROR_KIND.TEMPORARY,
    message: 'We could not save that image. Please try again.',
  },

  {
    match: /terms are not available|terms have been superseded|terms must be accepted/i,
    kind: ERROR_KIND.USER,
    message: 'Those terms could not be accepted. Reload the page and try again.',
  },

  {
    match: /no longer exists|not found|no_data_found/i,
    kind: ERROR_KIND.USER,
    message: 'We could not find that.',
  },

  {
    match: /answer window has closed|cannot be accepted from state|no longer in progress/i,
    kind: ERROR_KIND.CONFLICT,
    message: 'That is no longer possible — the order has moved on.',
  },

  {
    match: /account suspended/i,
    kind: ERROR_KIND.FORBIDDEN,
    message: 'This account is suspended. Contact Campus Dash support.',
  },

  {
    match: /vendor is not accepting orders/i,
    kind: ERROR_KIND.USER,
    message: 'That store has closed. Try another one.',
  },

  // --- MEAL SCANS ----------------------------------------------------------
  //
  // EVERY ONE OF THESE WAS UNMAPPED, so the whole scan flow answered a
  // question the customer could have fixed with "Something went wrong on our
  // side" — the one sentence that tells them to do nothing. They are Campus
  // Dash's own words, raised on purpose from price_scan_order() and
  // submit_scan_order(), and they name no table, no constraint and no id.

  {
    match: /not accepting meal scans/i,
    kind: ERROR_KIND.USER,
    message: 'That store is not taking meal scans right now. Try another one.',
  },

  {
    match: /cannot be paid for with a meal scan/i,
    kind: ERROR_KIND.USER,
    message: 'Something in your order cannot be paid for with a Meal Scan. Check it and try again.',
  },

  // The store has already approved or rejected it. Both are one-way.
  {
    match: /Meal Scan has already been dealt with/i,
    kind: ERROR_KIND.CONFLICT,
    message: 'This Meal Scan has already been dealt with.',
  },

  {
    match: /say why the Meal Scan could not be honoured/i,
    kind: ERROR_KIND.USER,
    message: 'Say why the Meal Scan is not valid.',
  },

  // Nobody has priced meal scans yet. The customer can do nothing about it and
  // waiting genuinely is the answer, so it reads as a service that is not up
  // rather than as their mistake.
  {
    match: /meal scans are not configured/i,
    kind: ERROR_KIND.TEMPORARY,
    message: 'Meal scan ordering is not available yet. Please try again later.',
  },

  {
    match: /attach your meal scan/i,
    kind: ERROR_KIND.USER,
    message: 'Attach your meal scan to continue.',
  },

  {
    match: /under 1000 characters/i,
    kind: ERROR_KIND.USER,
    message: 'That note is too long. Keep it under 1000 characters.',
  },

  // Says no more than that it is refused. Which account the scan does belong
  // to is not the asker's business.
  {
    match: /scan does not belong to this account/i,
    kind: ERROR_KIND.FORBIDDEN,
    message: 'That scan cannot be used on this account.',
  },

  // --- ORDERING, AND WHAT IS MISSING BEFORE IT CAN HAPPEN -------------------

  {
    match: /has not completed customer sign-up|complete your student details/i,
    kind: ERROR_KIND.USER,
    message: 'Finish signing up before you order.',
  },

  {
    match: /choose pickup or delivery/i,
    kind: ERROR_KIND.USER,
    message: 'Choose whether you are collecting it or want a Partner to bring it.',
  },

  // BEFORE the generic "is unavailable" line below, which used to swallow the
  // first of these and answer a Partner being switched off with "one of the
  // items is no longer available" — about the wrong thing entirely, and about
  // a basket the customer had no reason to doubt.
  {
    match: /partner delivery is unavailable|no Partners are available/i,
    kind: ERROR_KIND.USER,
    message: 'No Partners are available right now. Choose to collect it yourself.',
  },

  // --- A PRICE THE CUSTOMER CHOOSES ----------------------------------------
  //
  // menu_item_unit_price() refuses an amount that is not one of the item's
  // prices, or no amount at all for an item priced that way.

  {
    match: /is not one of its prices|choose an amount for/i,
    kind: ERROR_KIND.USER,
    message: 'An amount in your basket is not one of that item’s prices. Check it and try again.',
  },

  // THE PLATFORM CEILING, the same GH₵1,000 a fixed price has always had.
  {
    match: /more than any item can cost/i,
    kind: ERROR_KIND.USER,
    message: 'That amount is more than an item can cost on Campus Dash (GH₵1,000). Choose less.',
  },

  {
    match: /(starting price|price step|maximum price) looks wrong/i,
    kind: ERROR_KIND.USER,
    message: 'Prices on Campus Dash can be at most GH₵1,000.',
  },

  {
    match: /customer-chosen prices are not enabled/i,
    kind: ERROR_KIND.FORBIDDEN,
    message: 'Customer-chosen prices are not turned on for your store. Contact Campus Dash.',
  },

  {
    match: /customer-chosen price cannot take meal scans/i,
    kind: ERROR_KIND.USER,
    message: 'An item whose price the customer chooses cannot take meal scans.',
  },

  // ONE SENTENCE PER RULE. A single "check the prices" for all of them hid
  // which field was wrong — a maximum off the steps read like a bad step.
  {
    match: /maximum price must be one of the prices/i,
    kind: ERROR_KIND.USER,
    message:
      'The maximum must be one of your prices: the starting price plus whole steps. Or leave it empty.',
  },
  {
    match: /give the item a starting price/i,
    kind: ERROR_KIND.USER,
    message: 'Give a starting price, like 10.',
  },
  {
    match: /give the item a price step/i,
    kind: ERROR_KIND.USER,
    message: 'Give a step, like 5.',
  },
  {
    match: /at least one price|at most 20 prices|each price can be listed once/i,
    kind: ERROR_KIND.USER,
    message: 'List between one and 20 prices, each once.',
  },

  {
    match: /is unavailable/i,
    kind: ERROR_KIND.USER,
    message: 'One of the items is no longer available. Please check your basket.',
  },

  {
    match:
      /not a valid delivery location|require a destination|choose where the Partner should bring it/i,
    kind: ERROR_KIND.USER,
    message: 'Please choose somewhere we deliver to.',
  },

  // --- THE ACCOUNT AND THE STORE -------------------------------------------
  //
  // update_my_profile() and vendor_add_image() refuse in sentences already
  // written for the person reading them, and every one of these fell through
  // to the internal fallback: a vendor told that their number is their
  // credential read "something went wrong on our side" and had no idea why the
  // save had not taken.

  {
    match: /phone number is how you sign in/i,
    kind: ERROR_KIND.FORBIDDEN,
    message: 'Your phone number is how you sign in. Contact Campus Dash to change it.',
  },

  {
    match: /enter a valid phone number/i,
    kind: ERROR_KIND.USER,
    message: 'Enter a valid Ghanaian phone number, e.g. 020 123 4567.',
  },

  {
    match: /first name is required/i,
    kind: ERROR_KIND.USER,
    message: 'Enter your first name.',
  },

  {
    match: /graduation years offered|year you expect to graduate/i,
    kind: ERROR_KIND.USER,
    message: 'Choose the year you expect to graduate.',
  },

  {
    match: /at most 12 images/i,
    kind: ERROR_KIND.USER,
    message: 'A store can have at most 12 photos. Delete one before adding another.',
  },

  // --- THE STORE'S OWN MENU ------------------------------------------------
  //
  // BOTH OF THESE MUST COME BEFORE THE BASKET LINE BELOW, whose /at least one
  // item/ would otherwise swallow the first and answer a vendor pressing Open
  // with a sentence about a shopping basket they are not holding.

  {
    match: /turn at least one item on before you open/i,
    kind: ERROR_KIND.USER,
    message: 'Turn at least one item on before you open. A customer would arrive to an empty menu.',
  },

  {
    match: /sold out is the only reason/i,
    kind: ERROR_KIND.USER,
    message: 'Sold out is for an item you are serving. To stop offering it, turn it off.',
  },

  {
    match: /at least one item|invalid quantity|appears more than once/i,
    kind: ERROR_KIND.USER,
    message: 'There is a problem with your basket. Please check it and try again.',
  },

  {
    match: /code does not match|does not match/i,
    kind: ERROR_KIND.USER,
    message: 'That code is not right. Please check it and try again.',
  },

  {
    match: /amount mismatch/i,
    kind: ERROR_KIND.INTERNAL,
    message: 'We could not confirm that payment. Campus Dash support has been alerted.',
  },

  {
    match: /fetch failed|ECONNREFUSED|ETIMEDOUT|network|timeout/i,
    kind: ERROR_KIND.TEMPORARY,
    message: 'Something is slow right now. Please try again in a moment.',
  },
];

/**
 * @param {unknown} error
 * @param {string} [context] what the user was doing, for the server log
 * @returns {{ kind: string, status: number, message: string }}
 */
export function toUserError(error, context = 'action') {
  const raw = error instanceof Error ? error.message : String(error ?? '');

  // The full detail, only ever server-side.
  console.error(`[${context}]`, error instanceof Error ? (error.stack ?? raw) : raw);

  const matched = PATTERNS.find((pattern) => pattern.match.test(raw));
  if (matched) {
    return { kind: matched.kind, status: HTTP_STATUS[matched.kind], message: matched.message };
  }

  return {
    kind: ERROR_KIND.INTERNAL,
    status: HTTP_STATUS.INTERNAL,
    // Deliberately says nothing about what went wrong: an unmapped error's text
    // has not been checked for constraint names, table names or ids.
    message: 'Something went wrong on our side. Please try again.',
  };
}

/** Shape every server action returns, so screens render failures the same way. */
export function actionFailure(error, context) {
  const { kind, message } = toUserError(error, context);
  return { ok: false, kind, message };
}
