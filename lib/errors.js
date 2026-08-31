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

  {
    match: /already been taken|already accepted|lock_not_available/i,
    kind: ERROR_KIND.CONFLICT,
    message: 'Someone else got there first.',
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
    message: 'That stall has closed. Try another one.',
  },

  {
    match: /is unavailable/i,
    kind: ERROR_KIND.USER,
    message: 'One of the items is no longer available. Please check your basket.',
  },

  {
    match: /not a valid delivery location|require a destination/i,
    kind: ERROR_KIND.USER,
    message: 'Please choose somewhere we deliver to.',
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
