import Link from 'next/link';
import { formatPesewas } from '@/lib/util/money';

/**
 * ============================================================================
 * The Campus Dash component kit
 * ============================================================================
 *
 * Server-safe by design: nothing in here holds state or imports a hook, so a
 * server component can use every one of these directly and the marketplace
 * ships almost no JavaScript. The handful of pieces that genuinely need the
 * browser — the basket, the availability switch, the rating prompt — stay in
 * their own 'use client' files and import these for their presentation.
 *
 * The admin console has its own kit in app/admin/ui.js. It is denser on
 * purpose, and it now draws from the same tokens, so the two read as one
 * product without pretending an operations table is a consumer screen.
 */

/* ---------------------------------------------------------------------------
 * Layout
 * ------------------------------------------------------------------------- */

/**
 * The page measure.
 *
 * `wide` is the marketplace — a grid needs room. `default` suits reading and
 * forms. `narrow` is for a single focused task: a checkout, a status screen, a
 * sign-in. The references use exactly this narrowing as the task gets more
 * committed, and it is most of why their checkout feels calm.
 */
export function Container({ size = 'default', className = '', children }) {
  const sizes = {
    wide: 'max-w-6xl',
    default: 'max-w-4xl',
    narrow: 'max-w-xl',
  };
  return (
    <div className={`mx-auto w-full px-4 sm:px-6 ${sizes[size]} ${className}`}>{children}</div>
  );
}

/** A titled band of content, with the section rhythm applied once. */
export function Section({ title, description, action, className = '', children }) {
  return (
    <section className={`mt-10 first:mt-0 ${className}`}>
      {title ? (
        <div className="mb-4 flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
          <div>
            <h2 className="text-xl font-semibold tracking-tight sm:text-2xl">{title}</h2>
            {description ? (
              <p className="text-muted mt-1 text-sm leading-relaxed">{description}</p>
            ) : null}
          </div>
          {action ? <div className="shrink-0">{action}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

/**
 * The top of a page.
 *
 * `eyebrow` carries the small uppercase label the references put above a big
 * title. It is optional and should stay rare — used everywhere it becomes
 * decoration.
 */
export function PageHeader({ eyebrow, title, description, action, back, className = '' }) {
  return (
    <header className={`mb-7 ${className}`}>
      {back ? (
        <BackLink href={back.href} className="mb-3">
          {back.label}
        </BackLink>
      ) : null}
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
        <div className="min-w-0">
          {eyebrow ? (
            <p className="text-muted mb-2 text-xs font-semibold tracking-[0.14em] uppercase">
              {eyebrow}
            </p>
          ) : null}
          <h1 className="text-display text-3xl font-semibold sm:text-4xl">{title}</h1>
          {description ? (
            <p className="text-muted mt-2 max-w-prose leading-relaxed">{description}</p>
          ) : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
    </header>
  );
}

/* ---------------------------------------------------------------------------
 * Buttons
 * ------------------------------------------------------------------------- */

/**
 * Pills. The shape is the same at every size so a small secondary action and a
 * full-width primary read as the same family.
 *
 * `primary` is the only filled orange on a screen. It uses brand-700 rather
 * than the identity orange because it carries white text, and the identity
 * orange is not legible under it.
 */
const BUTTON_BASE =
  'press inline-flex items-center justify-center gap-2 rounded-full font-semibold ' +
  'disabled:cursor-not-allowed disabled:opacity-55 select-none whitespace-nowrap';

const BUTTON_VARIANTS = {
  primary: 'bg-brand-700 text-white hover:bg-brand-800',
  secondary: 'bg-surface text-ink border border-line-strong hover:bg-surface-2',
  subtle: 'bg-surface-2 text-ink hover:bg-surface-3',
  ghost: 'text-ink hover:bg-surface-2',
  danger: 'bg-surface text-bad border border-bad/30 hover:bg-bad-bg',
};

const BUTTON_SIZES = {
  sm: 'h-9 px-4 text-sm',
  md: 'h-11 px-5 text-sm',
  lg: 'h-13 px-6 text-base',
};

export function buttonClass({ variant = 'primary', size = 'md', block = false, className = '' }) {
  return [
    BUTTON_BASE,
    BUTTON_VARIANTS[variant] ?? BUTTON_VARIANTS.primary,
    BUTTON_SIZES[size] ?? BUTTON_SIZES.md,
    block ? 'w-full' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * `pending` is the tap acknowledged. The button disables itself so a second tap
 * cannot submit twice, says so to assistive technology with aria-busy, and
 * draws a spinner beside its label — at FULL strength, because a button that is
 * working is not a button that is unavailable, and on a phone the dimmed
 * disabled look reads as "that did not take". It never implies the operation
 * succeeded; the label the caller passes says what is happening.
 */
export function Button({
  variant = 'primary',
  size = 'md',
  block = false,
  pending = false,
  disabled = false,
  className = '',
  children,
  ...rest
}) {
  return (
    <button
      className={buttonClass({
        variant,
        size,
        block,
        className: pending ? `${className} cursor-progress disabled:opacity-100!` : className,
      })}
      disabled={disabled || pending}
      aria-busy={pending || undefined}
      {...rest}
    >
      {pending ? <Spinner /> : null}
      {children}
    </button>
  );
}

/** The in-flight mark. Inherits the button's text colour; still under reduced motion. */
export function Spinner({ className = 'size-[1.1em]' }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
      className={`shrink-0 animate-spin motion-reduce:animate-none ${className}`}
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

/** A link that looks like a button. Still a link — it navigates. */
export function ButtonLink({
  href,
  variant = 'primary',
  size = 'md',
  block = false,
  className = '',
  children,
  ...rest
}) {
  return (
    <Link href={href} className={buttonClass({ variant, size, block, className })} {...rest}>
      {children}
    </Link>
  );
}

/**
 * The inline link: accent text with a light underline that is ALWAYS there.
 *
 * It used to underline on hover only, which on a phone means never — the text
 * was orange and otherwise indistinguishable from a highlighted word. The rule
 * is that anything which navigates must look like it does before it is
 * touched, so the underline is present at rest, strengthens on hover, and the
 * link takes a soft ground while pressed.
 */
export const TEXT_LINK_CLASS =
  'text-brand-700 font-semibold underline decoration-brand-700/35 underline-offset-4 ' +
  'transition-colors hover:decoration-brand-700 active:bg-brand-50 rounded-sm';

export function TextLink({ href, className = '', children, ...rest }) {
  return (
    <Link href={href} className={`${TEXT_LINK_CLASS} ${className}`} {...rest}>
      {children}
    </Link>
  );
}

/**
 * "Back to …" — one shape everywhere.
 *
 * Every screen with a parent used to draw its own: an arrow glyph in the text,
 * an underlined grey word, an icon link. They all do the same thing, so they
 * now look the same, and every one is a 44px target that shows a ground when
 * pressed. The label names the destination, never just "Back".
 */
export function BackLink({ href, children, className = '' }) {
  return (
    <Link
      href={href}
      className={`text-muted hover:text-ink hover:bg-surface-2 press-sm -ml-2 inline-flex min-h-11 items-center gap-1.5 rounded-full pr-3.5 pl-2 text-sm font-medium transition-colors ${className}`}
    >
      <ArrowLeftIcon className="size-4" />
      {children}
    </Link>
  );
}

/* ---------------------------------------------------------------------------
 * Surfaces
 * ------------------------------------------------------------------------- */

/**
 * The card.
 *
 * A hairline and a surface, no shadow — depth in this system comes from the
 * surface stepping away from the canvas, which is what keeps a page of cards
 * from looking like a pile of receipts. `interactive` adds the hover and press
 * feedback for a card that is really a link.
 */
export function Card({ as: As = 'div', interactive = false, className = '', children, ...rest }) {
  return (
    <As
      className={`bg-surface border-line rounded-card border ${
        interactive ? 'press hover:border-line-strong block' : ''
      } ${className}`}
      {...rest}
    >
      {children}
    </As>
  );
}

/** A card with the standard padding already applied. */
export function Panel({ title, description, action, className = '', children }) {
  return (
    <Card className={className}>
      {title ? (
        <div className="border-line flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b px-5 py-4">
          <h2 className="font-semibold">{title}</h2>
          {description ? <p className="text-muted text-sm">{description}</p> : null}
          {action ? <div className="ml-auto">{action}</div> : null}
        </div>
      ) : null}
      <div className="p-5">{children}</div>
    </Card>
  );
}

/**
 * The soft accent panel — the "here is something worth noticing" block.
 * Deliberately not a card: no border, just a warm ground, so it reads as a
 * highlight rather than another container.
 */
export function Callout({ tone = 'brand', className = '', children }) {
  const tones = {
    brand: 'bg-brand-50 text-ink',
    warn: 'bg-warn-bg text-warn',
    bad: 'bg-bad-bg text-bad',
    good: 'bg-good-bg text-good',
    neutral: 'bg-surface-2 text-ink',
  };
  return (
    <div className={`rounded-panel px-5 py-4 text-sm leading-relaxed ${tones[tone]} ${className}`}>
      {children}
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Status
 * ------------------------------------------------------------------------- */

/** A small state mark. Never the primary way of saying something important. */
export function Badge({ tone = 'neutral', className = '', children }) {
  const tones = {
    neutral: 'bg-surface-2 text-muted',
    // brand-800 rather than brand-700: on the pale orange ground the lighter
    // one drops to 3.7:1, which is not enough for text this small.
    brand: 'bg-brand-100 text-brand-800',
    good: 'bg-good-bg text-good',
    warn: 'bg-warn-bg text-warn',
    bad: 'bg-bad-bg text-bad',
  };
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${tones[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

/**
 * A state dot.
 *
 * Static. It used to pulse, which looked like information and was decoration:
 * the dot's COLOUR already says what the state is, and a permanent animation on
 * a screen somebody refreshes while waiting for lunch is just movement in the
 * corner of their eye.
 */
export function LiveDot({ tone = 'good', className = '' }) {
  const tones = { good: 'bg-good', warn: 'bg-warn', bad: 'bg-bad', brand: 'bg-brand-500' };
  return <span className={`inline-block size-2 rounded-full ${tones[tone]} ${className}`} />;
}

/* ---------------------------------------------------------------------------
 * Empty, error and loading
 * ------------------------------------------------------------------------- */

/**
 * Nothing here — and why.
 *
 * An empty state that only says "no results" wastes the one moment the person
 * is actually reading. Every one of these takes an action.
 */
export function EmptyState({ icon, title, description, action, className = '' }) {
  return (
    <div className={`px-6 py-14 text-center ${className}`}>
      {icon ? <div className="text-faint mx-auto mb-4 flex justify-center">{icon}</div> : null}
      <p className="font-semibold">{title}</p>
      {description ? (
        <p className="text-muted mx-auto mt-1.5 max-w-sm text-sm leading-relaxed">{description}</p>
      ) : null}
      {action ? <div className="mt-5 flex justify-center">{action}</div> : null}
    </div>
  );
}

/**
 * "We could not ask", which is NOT "the answer is none".
 *
 * The distinction is the whole reason this component exists: an empty table and
 * a failed query look identical, and someone acting on the first when it is
 * really the second makes a confident, wrong decision.
 */
export function Unavailable({ className = '', children }) {
  return (
    <div
      role="status"
      className={`bg-warn-bg text-warn rounded-panel flex items-start gap-3 px-5 py-4 text-sm leading-relaxed ${className}`}
    >
      <AlertIcon className="mt-0.5 size-4 shrink-0" />
      <span>{children ?? 'This information could not be loaded.'}</span>
    </div>
  );
}

/** A form or action failure, in the same voice everywhere. */
export function ErrorNote({ className = '', children }) {
  if (!children) return null;
  return (
    <p
      role="alert"
      className={`bg-bad-bg text-bad rounded-input px-4 py-3 text-sm leading-relaxed ${className}`}
    >
      {children}
    </p>
  );
}

/** A completed action, in the same voice everywhere. The pair of ErrorNote. */
export function SuccessNote({ className = '', children }) {
  if (!children) return null;
  return (
    <p
      role="status"
      className={`bg-good-bg text-good rounded-input flex items-start gap-2.5 px-4 py-3 text-sm leading-relaxed font-medium ${className}`}
    >
      <CheckIcon className="mt-0.5 size-4 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

/**
 * The end of a journey: a tick, a headline, one line under it.
 *
 * Used where something that mattered has FINISHED — food collected, a delivery
 * handed over, an application sent. The tick draws itself once (see cd-draw)
 * and nothing else moves. It is the shape of a receipt, not a celebration.
 */
export function Completion({ title, children, action, className = '' }) {
  return (
    <div className={`animate-fade-up text-center ${className}`} role="status">
      <span className="bg-good mx-auto grid size-14 place-items-center rounded-full">
        <svg
          aria-hidden
          viewBox="0 0 24 24"
          fill="none"
          stroke="white"
          strokeWidth="2.75"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="size-7"
        >
          <path
            d="m20 6-11 11-5-5"
            className="motion-safe:animate-[cd-draw_380ms_ease-out_both]"
            style={{ strokeDasharray: 32 }}
          />
        </svg>
      </span>
      <p className="text-display mt-4 text-2xl font-semibold sm:text-3xl">{title}</p>
      {children ? (
        <div className="text-muted mx-auto mt-2 max-w-sm leading-relaxed">{children}</div>
      ) : null}
      {action ? <div className="mt-5 flex justify-center">{action}</div> : null}
    </div>
  );
}

/**
 * A figure that answers a question at a glance: "Today's sales GH₵420.00".
 *
 * The label sits ABOVE the number in plain words, so a row of these reads as a
 * sentence rather than as a set of numbers waiting to be decoded.
 */
export function Stat({ label, value, hint, className = '' }) {
  return (
    <div className={`bg-surface border-line rounded-card border px-4 py-3.5 ${className}`}>
      <dt className="text-muted text-sm font-medium">{label}</dt>
      <dd className="mt-1 text-2xl font-semibold tracking-tight tabular-nums sm:text-3xl">
        {value}
      </dd>
      {hint ? <p className="text-muted mt-0.5 text-xs">{hint}</p> : null}
    </div>
  );
}

/**
 * Four digits typed at a counter or a door.
 *
 * ONE INPUT FOR ALL THREE HANDOFFS, so a customer collecting, a Partner
 * collecting and a Partner delivering meet the same box: large, numeric
 * keypad, centred digits, and nothing else to aim at.
 */
export function CodeInput({ name, disabled = false, autoFocus = false, label }) {
  return (
    <input
      id={name}
      name={name}
      inputMode="numeric"
      autoComplete="one-time-code"
      required
      pattern="\d{4}"
      maxLength={4}
      placeholder="0000"
      disabled={disabled}
      autoFocus={autoFocus}
      aria-label={label}
      className="rounded-input bg-surface border-line-strong focus:border-brand-600 placeholder:text-faint/60 h-16 w-full border text-center text-3xl font-semibold tracking-[0.4em] tabular-nums outline-none disabled:opacity-60"
    />
  );
}

export function Skeleton({ className = '' }) {
  return <div className={`skeleton rounded-input ${className}`} />;
}

/** The marketplace's loading shape, so the grid does not jump when it lands. */
export function CardSkeleton() {
  return (
    <div className="space-y-3">
      <Skeleton className="rounded-card aspect-[16/10] w-full" />
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="h-3 w-1/3" />
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Money and data display
 * ------------------------------------------------------------------------- */

/** Money, always from integer pesewas. Never a float, never a client sum. */
export function Money({ pesewas, className = '' }) {
  return <span className={`tabular-nums ${className}`}>{formatPesewas(pesewas ?? 0)}</span>;
}

/** One line of a price breakdown. */
export function SummaryLine({ label, value, muted = true }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <dt className={muted ? 'text-muted text-sm' : 'text-sm font-medium'}>{label}</dt>
      <dd className="text-sm">
        <Money pesewas={value} />
      </dd>
    </div>
  );
}

/** The total, set apart above the rule as the references do. */
export function SummaryTotal({ label = 'Total', value }) {
  return (
    <div className="border-line mt-2 flex items-baseline justify-between gap-4 border-t pt-3">
      <dt className="font-semibold">{label}</dt>
      <dd className="text-lg font-semibold">
        <Money pesewas={value} />
      </dd>
    </div>
  );
}

/** A label/value row for detail screens. */
export function Fact({ label, value }) {
  return (
    <div className="border-line flex items-baseline justify-between gap-4 border-b py-2.5 last:border-0">
      <dt className="text-muted text-sm">{label}</dt>
      <dd className="text-right text-sm font-medium">{value ?? '-'}</dd>
    </div>
  );
}

export function Facts({ className = '', children }) {
  return <dl className={className}>{children}</dl>;
}

/**
 * A handover code, in the shape the references use: a soft panel, a label that
 * says who it is for, and the digits as separate tiles.
 *
 * Separating the digits is not decoration — it is what makes a code readable
 * across a counter, which is the only place it is ever used.
 */
export function CodeDisplay({ label, hint, code, tone = 'brand' }) {
  const digits = String(code ?? '').split('');
  const tiles = {
    brand: 'bg-brand-700 text-white',
    neutral: 'bg-surface text-ink border border-line',
  };
  return (
    <div className="bg-surface-2 rounded-panel flex flex-wrap items-center justify-between gap-4 px-5 py-4">
      <div>
        <p className="font-semibold">{label}</p>
        {hint ? <p className="text-muted mt-0.5 text-sm">{hint}</p> : null}
      </div>
      <div className="flex flex-wrap gap-1.5" aria-label={`Code ${digits.join(' ')}`}>
        {digits.map((digit, index) => (
          <span
            key={index}
            className={`grid size-11 place-items-center rounded-xl text-xl font-semibold tabular-nums ${tiles[tone]}`}
          >
            {digit}
          </span>
        ))}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Timeline
 * ------------------------------------------------------------------------- */

/**
 * Order progress.
 *
 * The hierarchy is the interesting part, and it is taken straight from the
 * references: a DONE step is muted, because it no longer needs attention, while
 * the CURRENT step is the only one set in full-strength text. Most timelines
 * get this backwards and shout about what already happened.
 */
export function Timeline({ steps }) {
  return (
    <ol className="relative">
      {steps.map((step, index) => {
        const last = index === steps.length - 1;
        const state = step.state ?? 'todo';
        return (
          <li key={index} className="relative flex gap-4 pb-6 last:pb-0">
            {!last ? (
              <span
                aria-hidden
                className={`absolute top-6 bottom-0 left-[11px] w-px ${
                  state === 'done' ? 'bg-good' : 'bg-line-strong'
                }`}
              />
            ) : null}

            <span className="relative z-10 mt-0.5 shrink-0">
              {state === 'done' ? (
                <span className="bg-good grid size-6 place-items-center rounded-full">
                  <CheckIcon className="size-3.5 text-white" />
                </span>
              ) : state === 'current' ? (
                <span className="border-good grid size-6 place-items-center rounded-full border-2">
                  <span className="bg-good size-2 rounded-full" />
                </span>
              ) : state === 'failed' ? (
                <span className="bg-bad grid size-6 place-items-center rounded-full">
                  <span className="h-0.5 w-2.5 rounded-full bg-white" />
                </span>
              ) : (
                <span className="grid size-6 place-items-center">
                  <span className="bg-line-strong size-2 rounded-full" />
                </span>
              )}
            </span>

            <div className="min-w-0 flex-1">
              <p
                className={`leading-snug ${
                  state === 'current'
                    ? 'text-ink font-semibold'
                    : state === 'failed'
                      ? 'text-bad font-medium'
                      : state === 'done'
                        ? 'text-muted'
                        : 'text-faint'
                }`}
              >
                {step.label}
              </p>
              {step.detail ? (
                <p className="text-muted mt-0.5 text-sm leading-relaxed">{step.detail}</p>
              ) : null}
            </div>

            {step.at ? (
              <span className="text-faint shrink-0 text-xs tabular-nums">{step.at}</span>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

/* ---------------------------------------------------------------------------
 * Marketplace
 * ------------------------------------------------------------------------- */

/**
 * The image ground for a vendor or item that has no photograph.
 *
 * A warm brand-tinted ground carrying the vendor's initials. It looks
 * intentional at any size, and it keeps working as the fallback for a vendor
 * who has not uploaded a photograph.
 */
export function ImagePlaceholder({ name = '', className = '', ratio = 'aspect-[16/10]' }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0])
    .join('')
    .toUpperCase();

  return (
    <div
      className={`image-ground rounded-card relative grid place-items-center overflow-hidden ${ratio} ${className}`}
      aria-hidden
    >
      <span className="text-brand-800/70 text-2xl font-semibold tracking-tight select-none">
        {initials || '-'}
      </span>
    </div>
  );
}

/**
 * A vendor in the marketplace grid.
 *
 * The composition follows the references exactly: image, a state chip over it,
 * then name and metadata beneath in decreasing weight. A closed store is not
 * hidden — knowing a place exists but is shut is useful — but it is desaturated
 * and not a link, so it cannot waste a tap.
 */
export function VendorCard({ vendor, href, meta = null, imageUrl = null }) {
  const open = vendor.is_accepting_orders;

  const body = (
    <>
      <div className="relative">
        {imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={imageUrl}
            alt=""
            loading="lazy"
            className={`rounded-card aspect-[16/10] w-full object-cover ${
              open ? '' : 'opacity-45 saturate-0'
            }`}
          />
        ) : (
          <ImagePlaceholder name={vendor.name} className={open ? '' : 'opacity-45 saturate-0'} />
        )}
        <div className="absolute top-3 left-3">
          {open ? (
            <span className="bg-surface text-good border-line inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold">
              <span className="bg-good size-1.5 rounded-full" />
              Open
            </span>
          ) : (
            <span className="bg-surface text-muted border-line rounded-full border px-2.5 py-1 text-xs font-semibold">
              Closed
            </span>
          )}
        </div>
      </div>
      <div className="px-1 pt-3">
        <p
          className={`leading-snug font-semibold break-words ${open ? '' : 'text-muted'}`}
          title={vendor.name}
        >
          {vendor.name}
        </p>
        {meta ? (
          <p className="text-muted mt-1 flex flex-wrap items-center gap-x-2 text-sm">{meta}</p>
        ) : null}
      </div>
    </>
  );

  if (!open) return <div className="cursor-default">{body}</div>;

  return (
    <Link
      href={href}
      className="press group focus-visible:outline-brand-600 block rounded-[16px] focus-visible:outline-2 focus-visible:outline-offset-4"
    >
      {body}
    </Link>
  );
}

/* ---------------------------------------------------------------------------
 * Forms
 * ------------------------------------------------------------------------- */

const FIELD_BASE =
  'w-full rounded-input bg-surface border border-line-strong px-4 text-[15px] text-ink ' +
  'placeholder:text-faint transition-colors focus:border-brand-600 outline-none';

export function Field({ label, hint, error, required, children, className = '' }) {
  return (
    <label className={`block ${className}`}>
      {label ? (
        <span className="mb-1.5 block text-sm font-medium">
          {label}
          {required ? <span className="text-bad"> *</span> : null}
        </span>
      ) : null}
      {children}
      {hint && !error ? <span className="text-muted mt-1.5 block text-xs">{hint}</span> : null}
      {error ? <span className="text-bad mt-1.5 block text-xs">{error}</span> : null}
    </label>
  );
}

export function Input({ className = '', ...rest }) {
  return <input className={`${FIELD_BASE} h-12 ${className}`} {...rest} />;
}

export function Textarea({ className = '', ...rest }) {
  return <textarea className={`${FIELD_BASE} min-h-24 py-3 ${className}`} {...rest} />;
}

export function Select({ className = '', children, ...rest }) {
  return (
    <select className={`${FIELD_BASE} h-12 appearance-none pr-10 ${className}`} {...rest}>
      {children}
    </select>
  );
}

/**
 * A segmented choice — the fulfilment picker, a filter.
 *
 * Renders as real radio inputs so it is keyboard- and screen-reader-native; the
 * pill is the label. A row of buttons would have needed roving tabindex and
 * would still have told a screen reader nothing about what is selected.
 */
export function SegmentedOption({ name, value, checked, onChange, children }) {
  return (
    <label className="press flex-1 cursor-pointer">
      <input
        type="radio"
        name={name}
        value={value}
        defaultChecked={checked}
        onChange={onChange}
        className="peer sr-only"
      />
      <span className="border-line-strong peer-checked:bg-brand-700 peer-checked:border-brand-700 peer-focus-visible:outline-brand-600 block rounded-full border px-4 py-2.5 text-center text-sm font-semibold transition-colors peer-checked:text-white peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2">
        {children}
      </span>
    </label>
  );
}

/* ---------------------------------------------------------------------------
 * Icons
 * ---------------------------------------------------------------------------
 * Inline SVG rather than an icon package: a dozen icons at ~200 bytes each
 * beats a dependency, and they inherit currentColor so a caller sets the colour
 * by setting text colour.
 */

function icon(path, { fill = false } = {}) {
  return function Icon({ className = 'size-5', ...rest }) {
    return (
      <svg
        viewBox="0 0 24 24"
        fill={fill ? 'currentColor' : 'none'}
        stroke={fill ? 'none' : 'currentColor'}
        strokeWidth={fill ? undefined : 1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={className}
        aria-hidden
        {...rest}
      >
        {path}
      </svg>
    );
  };
}

export const ArrowLeftIcon = icon(<path d="M19 12H5m0 0 7-7m-7 7 7 7" />);
export const ArrowRightIcon = icon(<path d="M5 12h14m0 0-7-7m7 7-7 7" />);
export const ChevronRightIcon = icon(<path d="m9 18 6-6-6-6" />);
export const CheckIcon = icon(<path d="m20 6-11 11-5-5" />);
export const SearchIcon = icon(
  <>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </>
);
export const BagIcon = icon(
  <>
    <path d="M6 7h12l-1 13H7L6 7Z" />
    <path d="M9 7V6a3 3 0 0 1 6 0v1" />
  </>
);
export const StoreIcon = icon(
  <>
    <path d="M4 9h16v11H4z" />
    <path d="M4 9 5.5 4h13L20 9" />
  </>
);
export const UserIcon = icon(
  <>
    <circle cx="12" cy="8" r="3.5" />
    <path d="M5 20a7 7 0 0 1 14 0" />
  </>
);
export const ClockIcon = icon(
  <>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </>
);
export const PinIcon = icon(
  <>
    <path d="M12 21s7-5.5 7-11a7 7 0 1 0-14 0c0 5.5 7 11 7 11Z" />
    <circle cx="12" cy="10" r="2.5" />
  </>
);
export const AlertIcon = icon(
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7.5v5M12 16h.01" />
  </>
);
export const ScanIcon = icon(
  <>
    <path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16" />
    <path d="M7 12h10" />
  </>
);
export const BikeIcon = icon(
  <>
    <circle cx="6" cy="17" r="3" />
    <circle cx="18" cy="17" r="3" />
    <path d="M6 17 10 8h4l2 9M9 8h6" />
  </>
);
export const ReceiptIcon = icon(
  <>
    <path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3Z" />
    <path d="M9.5 8h5M9.5 12h5" />
  </>
);
