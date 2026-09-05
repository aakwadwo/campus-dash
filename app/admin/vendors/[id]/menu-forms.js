'use client';

import { useActionState, useState } from 'react';
import {
  createMenuItemAction,
  updateMenuItemAction,
  setMenuItemAvailableAction,
  deleteMenuItemAction,
} from '../../actions';
import { Field, ReasonField, Button, ActionResult } from '../../ui';
import { ConfirmButton } from '../../confirm';

export default function MenuForms({ vendorId, items }) {
  const [createState, createAction, creating] = useActionState(createMenuItemAction, {});
  const [editState, editAction, editing] = useActionState(updateMenuItemAction, {});
  const [availState, availAction, toggling] = useActionState(setMenuItemAvailableAction, {});
  const [deleteState, deleteAction, deleting] = useActionState(deleteMenuItemAction, {});

  const [selectedId, setSelectedId] = useState(items[0]?.id ?? '');
  const selected = items.find((i) => i.id === selectedId);

  return (
    <div className="space-y-8">
      <form action={createAction} className="grid gap-4 sm:grid-cols-2">
        <h3 className="text-muted text-xs font-semibold uppercase sm:col-span-2">Add an item</h3>
        <input type="hidden" name="vendor_id" value={vendorId} />
        <Field label="Name" name="name" required placeholder="Jollof Rice with Chicken" />
        <Field
          label="Price (GH₵)"
          name="price_cedis"
          required
          placeholder="35.00"
          inputMode="decimal"
          hint="Cedis with at most two decimals. Stored as integer pesewas."
        />
        <div className="sm:col-span-2">
          <Field
            label="Description"
            name="description"
            placeholder="Jollof rice, grilled chicken, shito"
          />
        </div>
        <Field label="Sort order" name="sort_order" type="number" defaultValue="0" />
        <ReasonField placeholder="Vendor added this dish" />
        <div className="sm:col-span-2">
          <Button disabled={creating}>{creating ? 'Adding…' : 'Add item'}</Button>
          <ActionResult state={createState} />
        </div>
      </form>

      {items.length ? (
        <>
          <div className="border-line border-t pt-6">
            <label className="block">
              <span className="text-sm font-medium">Item to edit</span>
              <select
                value={selectedId}
                onChange={(event) => setSelectedId(event.target.value)}
                className="focus:border-brand-600 border-line-strong bg-surface mt-1 w-full rounded border px-3 py-2 text-sm outline-none"
              >
                {items.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {selected ? (
            <>
              <form action={editAction} className="grid gap-4 sm:grid-cols-2">
                <h3 className="text-muted text-xs font-semibold uppercase sm:col-span-2">
                  Edit “{selected.name}”
                </h3>
                <input type="hidden" name="menu_item_id" value={selected.id} />
                <Field label="Name" name="name" defaultValue={selected.name} />
                <Field
                  label="Price (GH₵)"
                  name="price_cedis"
                  defaultValue={selected.price_cedis}
                  inputMode="decimal"
                  hint="Orders already placed keep the price they were submitted at."
                />
                <div className="sm:col-span-2">
                  <Field
                    label="Description"
                    name="description"
                    defaultValue={selected.description ?? ''}
                  />
                </div>
                <Field
                  label="Sort order"
                  name="sort_order"
                  type="number"
                  defaultValue={selected.sort_order}
                />
                <ReasonField placeholder="Vendor raised the price" />
                <div className="sm:col-span-2">
                  <Button disabled={editing}>{editing ? 'Saving…' : 'Save item'}</Button>
                  <ActionResult state={editState} />
                </div>
              </form>

              <div className="border-line flex flex-wrap gap-6 border-t pt-6">
                <form action={availAction} className="flex items-end gap-2">
                  <input type="hidden" name="menu_item_id" value={selected.id} />
                  <input
                    type="hidden"
                    name="available"
                    value={selected.is_available ? 'false' : 'true'}
                  />
                  <Field
                    label="Reason"
                    name="reason"
                    required
                    minLength={3}
                    placeholder="Out of stock"
                  />
                  <Button variant="secondary" disabled={toggling}>
                    {selected.is_available ? 'Disable item' : 'Enable item'}
                  </Button>
                </form>

                {/* Deletion is confirmed; disabling is not. Disabling is
                    reversible in one click and is the thing an operator
                    normally wants — "we have run out" is not "this dish no
                    longer exists". The reason is still required either way:
                    the confirmation is in addition to the audit trail, never
                    instead of it. */}
                <form action={deleteAction} className="flex items-end gap-2">
                  <input type="hidden" name="menu_item_id" value={selected.id} />
                  <Field
                    label="Reason"
                    name="reason"
                    required
                    minLength={3}
                    placeholder="Added by mistake"
                  />
                  <ConfirmButton
                    pending={deleting}
                    pendingLabel="Deleting…"
                    confirmLabel="Yes, delete it"
                    question={`Delete “${selected.name}” from the menu? If you only need it off the menu for now, disable it instead, which is reversible.`}
                  >
                    Delete item
                  </ConfirmButton>
                </form>
              </div>
              <ActionResult state={availState} />
              <ActionResult state={deleteState} />
            </>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
