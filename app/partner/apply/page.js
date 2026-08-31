import { requireUser } from '@/lib/auth/session';
import ApplyForm from './apply-form';

export const dynamic = 'force-dynamic';

export default async function PartnerApplyPage() {
  await requireUser('/partner/apply');

  return (
    <main className="mx-auto max-w-md px-4 pt-6 pb-16">
      <h1 className="text-2xl font-semibold tracking-tight">Apply to be a Partner</h1>
      <p className="text-muted mt-2 text-sm leading-relaxed">
        An admin compares your face with your student ID by hand. That is why the selfie has to be
        taken here and now, with your camera.
      </p>
      <ApplyForm />
    </main>
  );
}
