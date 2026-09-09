'use client';

import { useActionState } from 'react';
import { createVendorCategoryAction, updateVendorCategoryAction } from '../actions';
import { Field, ReasonField, Button, ActionResult, Badge } from '../ui';

/**
 * The category list, editable in place.
 *
 * DISABLING IS NOT DELETING. A disabled category disappears from the sign-up
 * form and the customer filter; the stores already in it keep trading and every
 * historical order keeps the category it was placed under. There is no delete,
 * deliberately — deleting one would either orphan those stores or rewrite
 * history, and neither is a thing an operator should be able to do by accident.
 */
export default function CategoryForms({ categories }) {
  const [createState, create, creating] = useActionState(createVendorCategoryAction, {});
  const [updateState, update] = useActionState(updateVendorCategoryAction, {});

  return (
    <div className="space-y-6">
      <ul className="divide-line divide-y text-sm">
        {categories.map((category) => (
          <li key={category.id} className="flex flex-wrap items-center gap-3 py-2.5">
            <span className="font-medium">{category.name}</span>
            <span className="text-muted font-mono text-xs">{category.slug}</span>
            {category.is_active ? <Badge tone="good">active</Badge> : <Badge>disabled</Badge>}
            <span className="text-muted text-xs">
              {category.vendor_count} {category.vendor_count === 1 ? 'store' : 'stores'}
            </span>
            <form action={update} className="ml-auto flex items-center gap-2">
              <input type="hidden" name="category_id" value={category.id} />
              <input type="hidden" name="is_active" value={category.is_active ? 'false' : 'true'} />
              <input
                type="hidden"
                name="reason"
                value={
                  category.is_active ? 'Disabled from the console' : 'Re-enabled from the console'
                }
              />
              <button type="submit" className="text-brand-700 text-xs font-medium">
                {category.is_active ? 'Disable' : 'Enable'}
              </button>
            </form>
          </li>
        ))}
      </ul>
      <ActionResult state={updateState} />

      <form action={create} className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" name="name" required placeholder="Laundry" />
        <Field
          label="Slug"
          name="slug"
          required
          placeholder="laundry"
          hint="Lowercase, hyphenated. This is the stable id. The name is free to change later."
        />
        <Field label="Sort order" name="sort_order" type="number" defaultValue="130" />
        <div className="sm:col-span-2">
          <ReasonField placeholder="Two laundry services asked to join" />
        </div>
        <div className="sm:col-span-2">
          <Button disabled={creating}>{creating ? 'Adding…' : 'Add category'}</Button>
          <ActionResult state={createState} />
        </div>
      </form>
    </div>
  );
}
