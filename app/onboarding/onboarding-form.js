'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import { completeOnboardingAction } from './actions';

/**
 * The student details that grant the CUSTOMER capability.
 *
 * The student ID PHOTOGRAPH may come from the gallery — it is a document, and
 * most people already have a picture of it. The live camera requirement belongs
 * to the Partner application, where a face is being compared against this ID,
 * and it lives there rather than here.
 */
export default function OnboardingForm({ terms, next, defaultName }) {
  const [state, submit, submitting] = useActionState(completeOnboardingAction, {});
  const [idPath, setIdPath] = useState('');

  return (
    <form action={submit} className="mt-6 space-y-6">
      <input type="hidden" name="next" value={next} />
      <input type="hidden" name="terms_id" value={terms.terms_id} />
      <input type="hidden" name="student_id_image_path" value={idPath} />

      <label className="block">
        <span className="text-sm font-medium">
          Full name <span className="text-bad">*</span>
        </span>
        <input
          name="full_name"
          required
          defaultValue={defaultName}
          autoComplete="name"
          placeholder="As it appears on your student ID"
          className="border-line-strong mt-1 w-full rounded border px-3 py-2.5 text-base"
        />
      </label>

      <label className="block">
        <span className="text-sm font-medium">
          Student ID number <span className="text-bad">*</span>
        </span>
        <input
          name="student_id_number"
          required
          placeholder="e.g. 10012345"
          className="border-line-strong mt-1 w-full rounded border px-3 py-2.5 text-base"
        />
      </label>

      <label className="block">
        <span className="text-sm font-medium">
          Class year <span className="text-bad">*</span>
        </span>
        <input
          name="class_year"
          required
          placeholder="e.g. Class of 2029"
          className="border-line-strong mt-1 w-full rounded border px-3 py-2.5 text-base"
        />
      </label>

      <label className="block">
        <span className="text-sm font-medium">
          Email address <span className="text-bad">*</span>
        </span>
        <input
          name="email"
          type="email"
          required
          autoComplete="email"
          placeholder="you@example.com"
          className="border-line-strong mt-1 w-full rounded border px-3 py-2.5 text-base"
        />
        <span className="text-muted mt-1 block text-xs">
          Any working address, and it must not already be on another Campus Dash account. Your
          receipt goes here. A school address is not required.
        </span>
      </label>

      <StudentIdCapture path={idPath} onUploaded={setIdPath} />

      <section className="rounded-card bg-surface ring-line p-4 ring-1">
        <h2 className="text-sm font-medium">{terms.title}</h2>
        <div className="text-muted mt-2 max-h-44 overflow-y-auto text-xs leading-relaxed whitespace-pre-wrap">
          {terms.body}
        </div>
        <label className="mt-3 flex items-start gap-2.5 text-sm">
          {/* Required rather than pre-ticked: the version accepted is recorded
              against this account, so it has to be an act. */}
          <input type="checkbox" name="accept" required className="mt-0.5 size-4 shrink-0" />
          <span>
            I have read and accept these terms (version {terms.version}).{' '}
            <span className="text-bad">*</span>
          </span>
        </label>
      </section>

      {state.message ? (
        <p role="alert" className="text-bad text-sm">
          {state.message}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={submitting || !idPath}
        className="press bg-brand-500 text-ink w-full rounded-full py-4 text-base font-semibold transition-colors disabled:opacity-55"
      >
        {submitting ? 'Saving…' : 'Finish and start ordering'}
      </button>
    </form>
  );
}

/** A document, so a gallery photo is fine. */
function StudentIdCapture({ path, onUploaded }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [preview, setPreview] = usePreview();

  return (
    <section className="rounded-card bg-surface ring-line p-4 ring-1">
      <h2 className="text-sm font-medium">
        Photo of your student ID <span className="text-bad">*</span>
      </h2>
      <p className="text-muted mt-1 text-xs">
        Make sure the name, photo and ID number are readable. It is stored privately and is seen
        only by a Campus Dash administrator.
      </p>

      <input
        type="file"
        accept="image/jpeg,image/png,image/webp"
        capture="environment"
        disabled={busy}
        onChange={async (event) => {
          const file = event.target.files?.[0];
          if (!file) return;
          setBusy(true);
          setError(null);
          try {
            const uploaded = await upload('student-id', file, file.name);
            setPreview(URL.createObjectURL(file));
            onUploaded(uploaded);
          } catch (caught) {
            setError(caught.message);
          } finally {
            setBusy(false);
          }
        }}
        className="mt-3 w-full text-sm"
      />

      {busy ? <p className="text-muted mt-2 text-sm">Uploading…</p> : null}

      {preview ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={preview}
          alt="The student ID photograph you selected"
          className="ring-line mt-3 w-full rounded ring-1"
        />
      ) : null}
      {path ? (
        <p className="text-brand-700 mt-2 text-sm font-medium">
          ✓ Student ID received. Check the name, photo and number are readable, and choose another
          file above if not.
        </p>
      ) : null}
      {error ? <p className="text-bad mt-2 text-sm">{error}</p> : null}
    </section>
  );
}

async function upload(kind, blob, filename) {
  const form = new FormData();
  form.set('kind', kind);
  form.set('file', blob, filename);

  const response = await fetch('/api/verification/documents', { method: 'POST', body: form });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? 'Upload failed.');
  return body.path;
}

/**
 * An object URL that is revoked when it is replaced and when the component goes
 * away. Retrying five times should not pin five images in memory.
 */
function usePreview() {
  const [url, setUrl] = useState(null);
  const current = useRef(null);

  useEffect(
    () => () => {
      if (current.current) URL.revokeObjectURL(current.current);
    },
    []
  );

  const set = (next) => {
    if (current.current) URL.revokeObjectURL(current.current);
    current.current = next;
    setUrl(next);
  };

  return [url, set];
}
