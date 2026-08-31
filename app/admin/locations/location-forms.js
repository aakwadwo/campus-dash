'use client';

import { useActionState, useState } from 'react';
import {
  createLocationAction,
  updateLocationAction,
  setLocationActiveAction,
  deleteLocationAction,
} from '../actions';
import { Panel, Field, Select, ReasonField, Button, ActionResult } from '../ui';

const KINDS = ['CAMPUS', 'BLOCK', 'FLOOR', 'ROOM', 'FIELD', 'COMMON_AREA'];

export default function LocationForms({ locations }) {
  const [createState, createAction, creating] = useActionState(createLocationAction, {});
  const [editState, editAction, editing] = useActionState(updateLocationAction, {});
  const [activeState, activeAction, toggling] = useActionState(setLocationActiveAction, {});
  const [deleteState, deleteAction, deleting] = useActionState(deleteLocationAction, {});

  const [selectedId, setSelectedId] = useState(locations[0]?.id ?? '');
  const selected = locations.find((l) => l.id === selectedId);

  const indent = (l) => `${'— '.repeat(l.depth)}${l.name}`;

  return (
    <>
      <Panel title="Add a location" description="Everything except a CAMPUS needs a parent.">
        <form action={createAction} className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" name="name" required placeholder="Room 204" />
          <Select
            label="Kind"
            name="kind"
            required
            defaultValue="ROOM"
            options={KINDS.map((k) => ({ value: k, label: k }))}
          />
          <Select
            label="Parent"
            name="parent_id"
            defaultValue=""
            options={[
              { value: '', label: '— none (only for a CAMPUS) —' },
              ...locations.map((l) => ({ value: l.id, label: indent(l) })),
            ]}
          />
          <Field
            label="Walk from hub (minutes)"
            name="walk_minutes"
            type="number"
            min="0"
            hint="Blank means unknown; the Partner offer omits the estimate."
          />
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="is_deliverable" className="size-4" />
            Customers can choose this as a destination
          </label>
          <Field label="Sort order" name="sort_order" type="number" defaultValue="0" />
          <div className="sm:col-span-2">
            <ReasonField placeholder="New hostel block opened" />
          </div>
          <div className="sm:col-span-2">
            <Button disabled={creating}>{creating ? 'Creating…' : 'Create location'}</Button>
            <ActionResult state={createState} />
          </div>
        </form>
      </Panel>

      {locations.length ? (
        <Panel title="Edit a location" description="Re-parenting is deliberately not offered here.">
          <label className="mb-4 block">
            <span className="text-sm font-medium">Location</span>
            <select
              value={selectedId}
              onChange={(event) => setSelectedId(event.target.value)}
              className="focus:border-brand-600 mt-1 w-full rounded border border-black/15 bg-white px-3 py-2 text-sm outline-none"
            >
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {indent(l)}
                </option>
              ))}
            </select>
          </label>

          {selected ? (
            <>
              <form action={editAction} className="grid gap-4 sm:grid-cols-2">
                <input type="hidden" name="location_id" value={selected.id} />
                <Field label="Name" name="name" defaultValue={selected.name} />
                <Field
                  label="Walk from hub (minutes)"
                  name="walk_minutes"
                  type="number"
                  min="0"
                  defaultValue={selected.walk_minutes ?? ''}
                />
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    name="is_deliverable"
                    defaultChecked={selected.is_deliverable}
                    className="size-4"
                  />
                  Deliverable
                </label>
                <Field
                  label="Sort order"
                  name="sort_order"
                  type="number"
                  defaultValue={selected.sort_order}
                />
                <div className="sm:col-span-2">
                  <ReasonField placeholder="Renamed after refurbishment" />
                </div>
                <div className="sm:col-span-2">
                  <Button disabled={editing}>{editing ? 'Saving…' : 'Save location'}</Button>
                  <ActionResult state={editState} />
                </div>
              </form>

              <div className="mt-6 flex flex-wrap gap-6 border-t border-black/5 pt-6">
                <form action={activeAction} className="flex items-end gap-2">
                  <input type="hidden" name="location_id" value={selected.id} />
                  <input
                    type="hidden"
                    name="active"
                    value={selected.is_active ? 'false' : 'true'}
                  />
                  <Field
                    label="Reason"
                    name="reason"
                    required
                    minLength={3}
                    placeholder="Block closed for works"
                  />
                  <Button variant="secondary" disabled={toggling}>
                    {selected.is_active ? 'Deactivate' : 'Activate'}
                  </Button>
                </form>

                <form action={deleteAction} className="flex items-end gap-2">
                  <input type="hidden" name="location_id" value={selected.id} />
                  <Field
                    label="Reason"
                    name="reason"
                    required
                    minLength={3}
                    placeholder="Created by mistake"
                  />
                  <Button variant="danger" disabled={deleting}>
                    Delete
                  </Button>
                </form>
              </div>
              <ActionResult state={activeState} />
              <ActionResult state={deleteState} />
            </>
          ) : null}
        </Panel>
      ) : null}
    </>
  );
}
