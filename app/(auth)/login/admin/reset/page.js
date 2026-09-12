import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import ResetPasswordForm from './reset-form';

export const metadata = { title: 'Choose a new password · Campus Dash' };

/**
 * Step two: the form itself.
 *
 * Reached only from the recovery route, which has already spent the token and
 * established the session. That session is checked AGAIN here — and a third
 * time inside setAdminPassword — against `is_admin` in the database rather than
 * against anything the link or the cookie claimed. A visitor who simply types
 * this path with no recovery session is sent to ask for a link.
 */
export default async function AdminResetPasswordPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect('/login/admin/forgot?link=expired');

  const { data: capabilities } = await supabase.rpc('my_capabilities');
  if (!capabilities?.is_admin || capabilities?.is_suspended) {
    await supabase.auth.signOut();
    redirect('/login/admin/forgot?link=expired');
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-6 py-12">
      <p className="text-muted text-xs font-medium tracking-[0.2em] uppercase">Campus Dash</p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight">Choose a new password</h1>
      <p className="text-muted mt-2 text-sm leading-relaxed">
        Twelve characters or more. This account can cancel orders and move money, so pick something
        you do not use anywhere else.
      </p>

      <ResetPasswordForm email={user.email ?? ''} />
    </main>
  );
}
