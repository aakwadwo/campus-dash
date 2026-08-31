import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isDevInboxEnabled, record, recent } from '../lib/sms/dev-inbox.js';

/**
 * The development SMS inbox displays one-time passcodes in plain text. These
 * tests exist because that is only ever acceptable on a developer's own
 * machine, and the gate that guarantees it is one boolean.
 *
 * Both settings are read at call time rather than at import, which is what lets
 * a single import be tested against several environments here — and what stops
 * a long-running process from being stuck with a gate decided at boot.
 */

describe('development SMS inbox', () => {
  const original = { env: process.env.NODE_ENV, provider: process.env.SMS_PROVIDER };

  afterEach(() => {
    process.env.NODE_ENV = original.env;
    if (original.provider === undefined) delete process.env.SMS_PROVIDER;
    else process.env.SMS_PROVIDER = original.provider;
  });

  test('it is open in development with the fake provider', () => {
    process.env.NODE_ENV = 'development';
    process.env.SMS_PROVIDER = 'fake';
    assert.equal(isDevInboxEnabled(), true);
  });

  test('a production build shuts it, whatever the provider says', () => {
    process.env.NODE_ENV = 'production';
    process.env.SMS_PROVIDER = 'fake';
    assert.equal(isDevInboxEnabled(), false);
  });

  test('a real provider shuts it, even outside production', () => {
    process.env.NODE_ENV = 'development';
    process.env.SMS_PROVIDER = 'hubtel';
    assert.equal(isDevInboxEnabled(), false);
  });

  test('nothing is retained once the gate is shut', () => {
    process.env.NODE_ENV = 'production';
    process.env.SMS_PROVIDER = 'fake';
    record({ id: 'must-not-be-kept', phoneNumber: '+233200000021', message: 'code 123456' });
    assert.equal(
      recent().some((m) => m.id === 'must-not-be-kept'),
      false,
      'a passcode must never be held in production'
    );
  });

  // Source-level, because a refactor could drop either line and still compile.
  test('the page refuses to render unless the gate is open', () => {
    const source = readFileSync(new URL('../app/dev/inbox/page.js', import.meta.url), 'utf8');
    assert.match(source, /if \(!isDevInboxEnabled\(\)\) notFound\(\);/);
  });

  test('message bodies never reach the database, a log or a file', () => {
    const source = readFileSync(new URL('../lib/sms/dev-inbox.js', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /createClient|\.insert|writeFile|console\./);
  });
});
