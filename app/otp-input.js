'use client';

import { forwardRef, useState } from 'react';

/**
 * The six-digit code box, in one place.
 *
 * SIX, EXACTLY. Supabase issues a six-digit code for both the email and the SMS
 * flow (`otp_length = 6` in supabase/config.toml, and the matching Email/SMS OTP
 * Length on a hosted project). The input used to accept eight because the shape
 * check did, and an input that accepts more than can ever be issued teaches
 * people to distrust it — they count the boxes, count their code, and assume
 * something is wrong.
 *
 * This is NOT the four-digit handoff code. Those are ours, they are four digits
 * by design, and they have their own inputs — see hard rule 11.
 *
 * WHY ONE INPUT AND NOT SIX BOXES. Six separate boxes look tidy and then break
 * every keyboard behaviour people rely on: paste lands in one box, autofill from
 * an SMS fills one box, backspace strands the caret, and a screen reader
 * announces six unlabelled fields. A single input keeps paste, keeps iOS/Android
 * one-time-code autofill (`autoComplete="one-time-code"`), and is one labelled
 * field. The SPACING is what communicates six positions.
 *
 * The placeholder is six dashes rather than "123456", which reads as a code
 * somebody might type in by mistake.
 */
const OtpInput = forwardRef(function OtpInput(
  { name = 'token', disabled = false, autoFocus = false, onComplete = null, ...rest },
  ref
) {
  const [value, setValue] = useState('');

  /**
   * Digits only, six at most — applied to TYPED and PASTED input alike, because
   * both arrive here. A pasted "123 456" or a code copied with a trailing space
   * becomes six digits rather than a validation error.
   */
  function handleChange(event) {
    const digits = event.target.value.replace(/\D/g, '').slice(0, 6);
    setValue(digits);
    if (digits.length === 6) onComplete?.(digits);
  }

  return (
    <input
      ref={ref}
      name={name}
      value={value}
      onChange={handleChange}
      type="text"
      inputMode="numeric"
      autoComplete="one-time-code"
      // Tells a mobile browser this is a numeric one-time code, which is what
      // surfaces the code from the notification instead of the full keyboard.
      pattern="\d{6}"
      maxLength={6}
      required
      autoFocus={autoFocus}
      disabled={disabled}
      placeholder="------"
      aria-label="Six-digit code"
      className="rounded-input border-line-strong bg-surface focus:border-brand-600 placeholder:text-faint h-14 w-full border px-4 text-center text-2xl font-semibold tracking-[0.4em] tabular-nums transition-colors outline-none placeholder:tracking-[0.4em] disabled:opacity-60 sm:text-3xl"
      {...rest}
    />
  );
});

export default OtpInput;
