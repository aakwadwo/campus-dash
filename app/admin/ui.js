/**
 * Shared admin building blocks. Deliberately plain: this module has to be
 * correct and legible, not attractive. Polish comes after the vendor flow works.
 */

export function Panel({ title, description, children, actions }) {
  return (
    <section className="mb-8 rounded-lg bg-white ring-1 ring-black/5">
      <header className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-black/5 px-5 py-3">
        <h2 className="font-semibold">{title}</h2>
        {description ? <p className="text-muted text-sm">{description}</p> : null}
        {actions ? <div className="ml-auto">{actions}</div> : null}
      </header>
      <div className="px-5 py-4">{children}</div>
    </section>
  );
}

export function Field({
  label,
  name,
  type = 'text',
  required,
  defaultValue,
  placeholder,
  hint,
  ...rest
}) {
  return (
    <label className="block">
      <span className="text-sm font-medium">
        {label}
        {required ? <span className="text-red-700"> *</span> : null}
      </span>
      <input
        name={name}
        type={type}
        required={required}
        defaultValue={defaultValue ?? ''}
        placeholder={placeholder}
        className="focus:border-brand-600 mt-1 w-full rounded border border-black/15 px-3 py-2 text-sm outline-none"
        {...rest}
      />
      {hint ? <span className="text-muted mt-1 block text-xs">{hint}</span> : null}
    </label>
  );
}

export function Select({ label, name, options, defaultValue, required, hint }) {
  return (
    <label className="block">
      <span className="text-sm font-medium">
        {label}
        {required ? <span className="text-red-700"> *</span> : null}
      </span>
      <select
        name={name}
        required={required}
        defaultValue={defaultValue ?? ''}
        className="focus:border-brand-600 mt-1 w-full rounded border border-black/15 bg-white px-3 py-2 text-sm outline-none"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {hint ? <span className="text-muted mt-1 block text-xs">{hint}</span> : null}
    </label>
  );
}

/**
 * Every administrative override records WHY. The database enforces a minimum
 * length, so this is required in the markup too rather than failing later.
 */
export function ReasonField({ placeholder = 'Why are you doing this?' }) {
  return (
    <Field
      label="Reason (recorded in the audit log)"
      name="reason"
      required
      minLength={3}
      placeholder={placeholder}
    />
  );
}

export function Button({ children, variant = 'primary', ...rest }) {
  const styles = {
    primary: 'bg-brand-500 text-ink',
    secondary: 'bg-white text-ink ring-1 ring-black/15',
    danger: 'bg-white text-red-700 ring-1 ring-red-200',
  };
  return (
    <button
      type="submit"
      className={`rounded px-3 py-1.5 text-sm font-semibold ${styles[variant]}`}
      {...rest}
    >
      {children}
    </button>
  );
}

export function Badge({ children, tone = 'neutral' }) {
  const tones = {
    neutral: 'bg-black/5 text-muted',
    good: 'bg-brand-50 text-brand-700',
    warn: 'bg-amber-50 text-amber-800',
    bad: 'bg-red-50 text-red-700',
  };
  return (
    <span className={`rounded px-2 py-0.5 text-xs font-medium ${tones[tone]}`}>{children}</span>
  );
}

export function Empty({ children }) {
  return <p className="text-muted py-6 text-center text-sm">{children}</p>;
}

/** Renders the outcome of the last server action, success or failure. */
export function ActionResult({ state }) {
  if (!state?.message) return null;
  return (
    <p role="status" className={`mt-3 text-sm ${state.ok ? 'text-brand-700' : 'text-red-700'}`}>
      {state.message}
    </p>
  );
}
