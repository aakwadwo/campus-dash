const PHASES = [
  { n: 1, name: 'Project setup', status: 'done' },
  { n: 2, name: 'Database schema, constraints & RLS', status: 'next' },
  { n: 3, name: 'Phone OTP authentication', status: 'todo' },
  { n: 4, name: 'Admin vendor & menu management', status: 'todo' },
  { n: 5, name: 'Vendor module — accept, prepare, ready, handoff', status: 'todo' },
  { n: 6, name: 'Customer ordering', status: 'todo' },
  { n: 7, name: 'Fake payment end-to-end', status: 'todo' },
  { n: 8, name: 'Partner module', status: 'todo' },
];

const STATUS_STYLES = {
  done: 'bg-brand-600 text-white',
  next: 'bg-brand-50 text-brand-700 ring-1 ring-brand-500/30',
  todo: 'bg-black/5 text-muted',
};

export default function Home() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <p className="text-muted text-xs font-medium tracking-[0.2em] uppercase">
        Academic City University
      </p>
      <h1 className="mt-2 text-4xl font-semibold tracking-tight">Campus Dash</h1>
      <p className="text-muted mt-3 text-base leading-relaxed">
        Order food, drinks and snacks from approved vendors around campus. Collect it yourself, or
        let a verified student Partner bring it to you.
      </p>

      <section className="mt-12">
        <h2 className="text-sm font-semibold tracking-wide uppercase">Build progress</h2>
        <ol className="mt-4 space-y-2">
          {PHASES.map((phase) => (
            <li
              key={phase.n}
              className="flex items-center gap-3 rounded-lg bg-white px-4 py-3 ring-1 ring-black/5"
            >
              <span
                className={`grid size-7 shrink-0 place-items-center rounded-full text-xs font-semibold ${STATUS_STYLES[phase.status]}`}
              >
                {phase.n}
              </span>
              <span className={phase.status === 'todo' ? 'text-muted' : ''}>{phase.name}</span>
            </li>
          ))}
        </ol>
      </section>

      <p className="text-muted mt-10 text-sm">
        Foundation check:{' '}
        <a className="text-brand-700 underline underline-offset-4" href="/api/health">
          /api/health
        </a>
      </p>
    </main>
  );
}
