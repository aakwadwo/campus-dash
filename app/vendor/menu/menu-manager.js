'use client';

import { useActionState, useEffect, useState } from 'react';
import {
  setMenuItemAvailableAction,
  createMenuItemAction,
  updateMenuItemAction,
  deleteMenuItemAction,
} from '../actions';
import { formatPesewas } from '@/lib/util/money';
import {
  Button,
  Card,
  Field,
  Input,
  Textarea,
  ErrorNote,
  SuccessNote,
  EmptyState,
  BagIcon,
} from '@/app/ui';

/**
 * The store's menu, as a thing a cook can actually operate.
 *
 * THREE ACTS, KEPT VISIBLY APART, because conflating them is what makes menu
 * management confusing everywhere it is confusing:
 *
 *   SOLD OUT    today's problem. One tap, reversible, and it clears itself when
 *               the store reopens. It is the control a busy counter reaches for
 *               forty times a day, so it is the one that is always visible.
 *   OFF THE MENU  deliberate, and stays until somebody puts it back.
 *   DELETE      it is not a thing this store sells. Behind the edit panel, and
 *               absent entirely once anybody has ordered it — the server
 *               refuses that anyway, and offering a button that always fails is
 *               worse than not offering it.
 *
 * EVERY ROW IS ITS OWN FORM with its own pending state, so marking the jollof
 * sold out does not grey out the waakye.
 */
export default function MenuManager({ vendorId, items }) {
  const [adding, setAdding] = useState(false);

  return (
    <>
      <div className="mb-4 flex items-center justify-between gap-4">
        <h2 className="font-semibold">Your items</h2>
        <Button
          type="button"
          variant={items.length === 0 ? 'primary' : 'secondary'}
          onClick={() => setAdding((open) => !open)}
        >
          {adding ? 'Cancel' : 'Add an item'}
        </Button>
      </div>

      {adding ? <AddItem vendorId={vendorId} onDone={() => setAdding(false)} /> : null}

      {items.length === 0 ? (
        adding ? null : (
          <Card>
            <EmptyState
              icon={<BagIcon className="size-6" />}
              title="Nothing on your menu yet"
              description="Add what you sell. Items appear to customers as soon as you add them, and you can mark anything sold out in one tap."
              action={
                <Button type="button" onClick={() => setAdding(true)}>
                  Add your first item
                </Button>
              }
            />
          </Card>
        )
      ) : (
        <ul className="space-y-2.5">
          {items.map((item) => (
            <li key={item.id}>
              <MenuRow item={item} vendorId={vendorId} />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/* ---------------------------------------------------------------------------
 * One item
 * ------------------------------------------------------------------------ */

function MenuRow({ item, vendorId }) {
  const [editing, setEditing] = useState(false);
  const [availability, toggle, toggling] = useActionState(setMenuItemAvailableAction, {});

  const soldOut = !item.is_available && item.unavailable_reason === 'SOLD_OUT';
  const withdrawn = item.unavailable_reason === 'WITHDRAWN';

  return (
    <Card className={`p-3.5 sm:p-4 ${item.is_available ? '' : 'bg-surface-2/50'}`}>
      <div className="flex items-start gap-3.5">
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-3">
            <p className={`font-semibold break-words ${item.is_available ? '' : 'text-muted'}`}>
              {item.name}
            </p>
            <p
              className={`shrink-0 font-semibold tabular-nums ${item.is_available ? '' : 'text-muted'}`}
            >
              {formatPesewas(item.price_pesewas)}
            </p>
          </div>

          {item.description ? (
            <p className="text-muted mt-1 text-sm leading-relaxed">{item.description}</p>
          ) : null}

          <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
            {soldOut ? <span className="text-warn font-semibold">Sold out today</span> : null}
            {withdrawn ? <span className="text-muted font-semibold">Off the menu</span> : null}
            {item.scan_eligible ? (
              <span className="bg-brand-50 text-brand-800 rounded px-1.5 py-0.5 font-semibold">
                Takes meal scans
              </span>
            ) : null}
          </p>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {/* THE ONE A COUNTER REACHES FOR. Always visible, one tap, and it
                says what happens next rather than only what it does. */}
            <form action={toggle}>
              <input type="hidden" name="menu_item_id" value={item.id} />
              <input type="hidden" name="vendor_id" value={vendorId} />
              <input type="hidden" name="name" value={item.name} />
              <input type="hidden" name="available" value={item.is_available ? 'false' : 'true'} />
              <input type="hidden" name="reason" value="SOLD_OUT" />
              <Button
                type="submit"
                size="sm"
                variant={item.is_available ? 'secondary' : 'primary'}
                pending={toggling}
              >
                {item.is_available ? 'Mark sold out' : 'Put back on'}
              </Button>
            </form>

            <button
              type="button"
              onClick={() => setEditing((open) => !open)}
              className="text-muted hover:text-ink press-sm min-h-9 rounded-full px-2 text-sm font-medium transition-colors"
            >
              {editing ? 'Close' : 'Edit'}
            </button>
          </div>

          {availability.message ? (
            availability.ok ? (
              <SuccessNote className="mt-2.5">{availability.message}</SuccessNote>
            ) : (
              <ErrorNote className="mt-2.5">{availability.message}</ErrorNote>
            )
          ) : null}
        </div>
      </div>

      {editing ? (
        <EditItem item={item} vendorId={vendorId} onDone={() => setEditing(false)} />
      ) : null}
    </Card>
  );
}

/* ---------------------------------------------------------------------------
 * Adding and editing
 * ------------------------------------------------------------------------ */

function AddItem({ vendorId, onDone }) {
  const [state, submit, pending] = useActionState(createMenuItemAction, {});

  // The form is REPLACED on success rather than left filled in, which reads as
  // "nothing happened" and invites a second identical item.
  useEffect(() => {
    if (state.ok) onDone();
  }, [state.ok, onDone]);

  return (
    <Card className="border-brand-600 ring-brand-600/20 animate-fade-up mb-4 p-5 ring-1">
      <h3 className="mb-4 font-semibold">Add an item</h3>
      <form action={submit} className="space-y-4">
        <input type="hidden" name="vendor_id" value={vendorId} />
        <ItemFields />
        <div className="flex gap-2">
          <Button type="submit" pending={pending}>
            {pending ? 'Adding…' : 'Add to menu'}
          </Button>
          <Button type="button" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
        </div>
        {state.message && !state.ok ? <ErrorNote>{state.message}</ErrorNote> : null}
      </form>
    </Card>
  );
}

function EditItem({ item, vendorId, onDone }) {
  const [state, submit, pending] = useActionState(updateMenuItemAction, {});
  const [removing, remove, deleting] = useActionState(deleteMenuItemAction, {});
  const [confirming, setConfirming] = useState(false);
  const [withdrawState, withdraw, withdrawing] = useActionState(setMenuItemAvailableAction, {});

  const ordered = Number(item.order_count ?? 0) > 0;
  const withdrawn = item.unavailable_reason === 'WITHDRAWN';

  return (
    <div className="border-line animate-fade-up mt-4 border-t pt-4">
      <form action={submit} className="space-y-4">
        <input type="hidden" name="vendor_id" value={vendorId} />
        <input type="hidden" name="menu_item_id" value={item.id} />
        <ItemFields item={item} />
        <div className="flex gap-2">
          <Button type="submit" size="sm" pending={pending}>
            {pending ? 'Saving…' : 'Save changes'}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={onDone}>
            Done
          </Button>
        </div>
        {state.message ? (
          state.ok ? (
            <SuccessNote>{state.message}</SuccessNote>
          ) : (
            <ErrorNote>{state.message}</ErrorNote>
          )
        ) : null}
      </form>

      <div className="border-line mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-t pt-4">
        {/* OFF THE MENU, not sold out. Deliberate, and it stays until somebody
            puts it back — reopening the store will not clear it. */}
        <form action={withdraw}>
          <input type="hidden" name="menu_item_id" value={item.id} />
          <input type="hidden" name="vendor_id" value={vendorId} />
          <input type="hidden" name="name" value={item.name} />
          <input type="hidden" name="available" value={withdrawn ? 'true' : 'false'} />
          <input type="hidden" name="reason" value="WITHDRAWN" />
          <button
            type="submit"
            disabled={withdrawing}
            className="text-muted hover:text-ink press-sm min-h-9 text-sm font-medium transition-colors disabled:opacity-55"
          >
            {withdrawing
              ? 'Saving…'
              : withdrawn
                ? 'Put back on the menu'
                : 'Take off the menu until I put it back'}
          </button>
        </form>

        {/* DELETE IS ABSENT once anybody has ordered it. The server refuses it,
            and a button that always fails is worse than no button — the row
            already carries the count that decides this. */}
        {ordered ? (
          <p className="text-faint text-xs">
            Ordered before, so it cannot be deleted. Taking it off the menu does the same thing.
          </p>
        ) : confirming ? (
          <form action={remove} className="flex items-center gap-2">
            <input type="hidden" name="menu_item_id" value={item.id} />
            <input type="hidden" name="vendor_id" value={vendorId} />
            <input type="hidden" name="name" value={item.name} />
            <span className="text-sm font-medium">Delete {item.name}?</span>
            <Button type="submit" size="sm" variant="danger" pending={deleting}>
              {deleting ? 'Deleting…' : 'Yes, delete'}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setConfirming(false)}>
              No
            </Button>
          </form>
        ) : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="text-muted hover:text-bad press-sm min-h-9 text-sm font-medium transition-colors"
          >
            Delete
          </button>
        )}
      </div>

      {withdrawState.message && !withdrawState.ok ? (
        <ErrorNote className="mt-2">{withdrawState.message}</ErrorNote>
      ) : null}
      {removing.message && !removing.ok ? (
        <ErrorNote className="mt-2">{removing.message}</ErrorNote>
      ) : null}
    </div>
  );
}

/** The fields an item has, shared by add and edit so the two cannot drift. */
function ItemFields({ item = null }) {
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-[1fr_9rem]">
        <Field label="Name">
          <Input name="name" required maxLength={120} defaultValue={item?.name ?? ''} />
        </Field>
        <Field label="Price" hint="In cedis">
          <Input
            name="price"
            required
            inputMode="decimal"
            placeholder="35.00"
            defaultValue={item ? (item.price_pesewas / 100).toFixed(2) : ''}
          />
        </Field>
      </div>

      <Field label="Description" hint="Optional. What is in it.">
        <Textarea
          name="description"
          rows={2}
          maxLength={280}
          defaultValue={item?.description ?? ''}
        />
      </Field>

      <label className="flex items-start gap-3">
        <input
          type="checkbox"
          name="scan_eligible"
          defaultChecked={item?.scan_eligible ?? false}
          className="accent-brand-500 mt-0.5 size-4 shrink-0"
        />
        <span className="text-muted text-sm leading-relaxed">
          A student may pay for this with a campus meal scan.
          <span className="text-faint block text-xs">
            Only has an effect if Campus Dash has turned meal scans on for your store.
          </span>
        </span>
      </label>
    </>
  );
}
