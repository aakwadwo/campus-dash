'use client';

import { useActionState, useState } from 'react';
import Link from 'next/link';
import { createVendorCategoryAction, updateVendorCategoryAction } from '../actions';
import { Field, ReasonField, Button, ActionResult, Badge } from '../ui';

/**
 * The category list, editable in place.
 *
 * DISABLING IS NOT DELETING, and there is no delete. Deleting a category would
 * either orphan the stores filed under it or rewrite what they chose. Disabling
 * does what anybody reaching for delete actually wants: it disappears from the
 * sign-up form and the customer filter, while every store already in it keeps
 * trading and every historical order keeps the category it was placed under.
 *
 * EVERY EDIT NEEDS A REASON, because every one of these writes to
 * admin_actions. A renamed category changes what customers see on the front
 * page, and "who changed this and why" is the question asked afterwards.
 */
export default function CategoryForms({ categories }) {
  const [createState, create, creating] = useActionState(createVendorCategoryAction, {});
  const [adding, setAdding] = useState(false);

  return (
    <div className="space-y-6">
      <ul className="divide-line divide-y">
        {categories.map((category) => (
          <li key={category.id}>
            <CategoryRow category={category} />
          </li>
        ))}
      </ul>

      <div className="border-line border-t pt-5">
        {adding ? (
          <form action={create} className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" name="name" required placeholder="Laundry" />
            <Field
              label="Slug"
              name="slug"
              required
              placeholder="laundry"
              hint="Lowercase, hyphenated. This is the stable id — the name is free to change later."
            />
            <Field label="Sort order" name="sort_order" type="number" defaultValue="130" />
            <div className="sm:col-span-2">
              <ReasonField placeholder="Two laundry services asked to join" />
            </div>
            <div className="flex gap-2 sm:col-span-2">
              <Button disabled={creating}>{creating ? 'Adding…' : 'Add category'}</Button>
              <Button type="button" variant="secondary" onClick={() => setAdding(false)}>
                Cancel
              </Button>
            </div>
            <div className="sm:col-span-2">
              <ActionResult state={createState} />
            </div>
          </form>
        ) : (
          <Button type="button" onClick={() => setAdding(true)}>
            Add a category
          </Button>
        )}
      </div>
    </div>
  );
}

function CategoryRow({ category }) {
  const [state, update, pending] = useActionState(updateVendorCategoryAction, {});
  const [editing, setEditing] = useState(false);

  const stores = Number(category.vendor_count ?? 0);

  return (
    <div className="py-3.5">
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-medium">{category.name}</span>
        <span className="text-muted font-mono text-xs">{category.slug}</span>
        {category.is_active ? <Badge tone="good">active</Badge> : <Badge>disabled</Badge>}

        {/* THE DEPENDENCY, stated on the row. An operator deciding whether to
            disable something needs to know who is in it before they do, not
            afterwards from a complaint. */}
        <Link
          href={`/admin/vendors?category=${category.id}`}
          className="text-muted hover:text-ink text-xs underline underline-offset-4"
        >
          {stores} {stores === 1 ? 'store' : 'stores'}
        </Link>

        {category.is_active && stores === 0 ? (
          <span className="text-warn text-xs font-medium">
            shown to customers with nothing in it
          </span>
        ) : null}

        <span className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => setEditing((open) => !open)}
            className="text-muted hover:text-ink press-sm min-h-8 rounded px-2 text-xs font-medium transition-colors"
          >
            {editing ? 'Close' : 'Rename'}
          </button>

          <form action={update} className="flex items-center gap-2">
            <input type="hidden" name="category_id" value={category.id} />
            <input type="hidden" name="name" value={category.name} />
            <input type="hidden" name="sort_order" value={category.sort_order} />
            <input type="hidden" name="is_active" value={category.is_active ? 'false' : 'true'} />
            <input
              type="hidden"
              name="reason"
              value={
                category.is_active
                  ? `Disabled from the console (${stores} stores stay open)`
                  : 'Re-enabled from the console'
              }
            />
            <button
              type="submit"
              disabled={pending}
              className="text-brand-700 press-sm min-h-8 rounded px-2 text-xs font-semibold disabled:opacity-55"
            >
              {pending ? 'Saving…' : category.is_active ? 'Disable' : 'Enable'}
            </button>
          </form>
        </span>
      </div>

      {editing ? (
        <form action={update} className="animate-fade-up mt-3 grid gap-3 sm:grid-cols-[1fr_8rem]">
          <input type="hidden" name="category_id" value={category.id} />
          <input type="hidden" name="is_active" value={category.is_active ? 'true' : 'false'} />
          <Field label="Name" name="name" required defaultValue={category.name} />
          <Field
            label="Sort order"
            name="sort_order"
            type="number"
            defaultValue={category.sort_order}
          />
          <div className="sm:col-span-2">
            {/* THE SLUG IS NOT EDITABLE. It is the stable id the storefront
                filter and every historical link use; a name is what people
                read and is free to change under it. */}
            <p className="text-faint mb-3 text-xs">
              The slug <span className="font-mono">{category.slug}</span> does not change — it is
              the stable id links and filters use.
            </p>
            <ReasonField placeholder="Renamed after the stores asked" />
          </div>
          <div className="flex gap-2 sm:col-span-2">
            <Button disabled={pending}>{pending ? 'Saving…' : 'Save'}</Button>
            <Button type="button" variant="secondary" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : null}

      <ActionResult state={state} />
    </div>
  );
}
