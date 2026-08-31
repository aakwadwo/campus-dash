import { config } from '../config.js';

/**
 * In-memory record of messages the FAKE sms provider handled, so a developer can
 * read a one-time passcode in the browser during a manual walkthrough instead of
 * digging through terminal scrollback while switching between four signed-in
 * roles.
 *
 * Kept on globalThis deliberately. Next.js compiles server components and route
 * handlers into separate module graphs, so a plain module-level array would be
 * written by the Send SMS Hook route and read as empty by the page. It also
 * means the buffer survives hot reload, which is the whole point in dev.
 *
 * NOTHING IS RETAINED IN PRODUCTION. record() returns immediately, so no message
 * body — passcodes included — is ever held anywhere but a developer's own
 * process memory. There is no database table, no log line and no file.
 */

const RETAINED = 25;
const KEY = Symbol.for('campus-dash.dev-sms-inbox');

function store() {
  globalThis[KEY] ??= [];
  return globalThis[KEY];
}

export function isDevInboxEnabled() {
  return !config.isProduction() && config.smsProvider() === 'fake';
}

export function record(message) {
  if (!isDevInboxEnabled()) return;
  const messages = store();
  messages.push(message);
  if (messages.length > RETAINED) messages.shift();
}

/** Most recent first. */
export function recent() {
  return [...store()].reverse();
}
