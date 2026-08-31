export const metadata = { title: 'Account suspended · Campus Dash' };

export default function SuspendedPage() {
  return (
    <main className="mx-auto max-w-sm px-6 py-24 text-center">
      <h1 className="text-2xl font-semibold tracking-tight">Account suspended</h1>
      <p className="text-muted mt-3 text-sm leading-relaxed">
        This account cannot place or deliver orders right now. Contact Campus Dash support if you
        think this is a mistake.
      </p>
    </main>
  );
}
