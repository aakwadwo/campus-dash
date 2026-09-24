'use client';

import { useActionState, useEffect, useMemo, useOptimistic, useState } from 'react';
import {
  setMenuItemActiveAction,
  setMenuItemAvailableAction,
  createMenuItemAction,
  updateMenuItemAction,
  deleteMenuItemAction,
} from '../actions';
import { cedisInputFromPesewas } from '@/lib/util/money';
import {
  PRICING_MODE,
  isVariablePrice,
  priceChoices,
  priceSummary,
  parseCedis,
  checkSteppedRule,
  steppedPreview,
  parsePriceList,
} from '@/lib/util/item-price';
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
  SegmentedOption,
} from '@/app/ui';

/**
 * One list. Everything the store sells, and a switch on each.
 *
 * THE CATALOGUE IS THE THING YOU KEEP; the menu is the thing you turn on. A
 * stall sells eggs in the morning and jollof at one, and the old screen made
 * that a chore of adding and deleting the same four dishes every day. So an
 * item is added once and stays, and the only daily act is a switch.
 *
 * TWO CONTROLS, AND THEY MEAN DIFFERENT THINGS.
 *
 *   ON / OFF   am I serving this at all today. OFF is invisible to customers.
 *   SOLD OUT   I am serving it and it has run out. The customer still sees it,
 *              marked, because a dish that vanishes reads as a store that
 *              stopped selling it. It clears itself when the store next opens.
 *
 * Sold out sits INSIDE the row rather than beside the switch, because it only
 * exists for an item that is on — and because two similar-looking buttons on
 * one line is how a cook marks the wrong thing at a counter.
 *
 * EVERY ROW IS ITS OWN FORM with its own pending state, so turning the jollof
 * off does not grey out the waakye.
 */
export default function MenuManager({ vendorId, items, storeOpen, variablePricing = false }) {
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState('');
  const [openRow, setOpenRow] = useState(null);

  const on = items.filter((i) => i.is_active);

  // A CATALOGUE IS SEARCHED, NOT SCROLLED — but only once it is long enough to
  // need it. Six items fit on a phone.
  const searchable = items.length > 6;
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (i) => i.name.toLowerCase().includes(q) || (i.description ?? '').toLowerCase().includes(q)
    );
  }, [items, query]);

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-semibold">
          {items.length === 0 ? 'Your items' : `${on.length} of ${items.length} on the menu`}
        </h2>
        <Button
          type="button"
          variant={items.length === 0 ? 'primary' : 'secondary'}
          onClick={() => setAdding((open) => !open)}
        >
          {adding ? 'Cancel' : 'Add an item'}
        </Button>
      </div>

      {adding ? (
        <AddItem
          vendorId={vendorId}
          variablePricing={variablePricing}
          onDone={() => setAdding(false)}
        />
      ) : null}

      {searchable ? (
        <Input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search your items"
          aria-label="Search your items"
          className="mb-3"
        />
      ) : null}

      {items.length === 0 ? (
        adding ? null : (
          <Card>
            <EmptyState
              icon={<BagIcon className="size-6" />}
              title="Nothing in your items yet"
              description="Add everything you sell, once. Then turn things on when you are serving them and off when you are not — nothing is ever deleted by a switch."
              action={
                <Button type="button" onClick={() => setAdding(true)}>
                  Add your first item
                </Button>
              }
            />
          </Card>
        )
      ) : matches.length === 0 ? (
        <Card className="p-5">
          <p className="text-muted text-sm">Nothing matches “{query.trim()}”.</p>
        </Card>
      ) : (
        <ul className="space-y-2.5">
          {matches.map((item) => (
            <li key={item.id}>
              <MenuRow
                item={item}
                vendorId={vendorId}
                storeOpen={storeOpen}
                variablePricing={variablePricing}
                expanded={openRow === item.id}
                onToggleDetails={() => setOpenRow((id) => (id === item.id ? null : item.id))}
              />
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

function MenuRow({ item, vendorId, storeOpen, variablePricing, expanded, onToggleDetails }) {
  // THE SWITCH MOVES ON THE TAP, NOT ON THE ANSWER. The answer is a round trip
  // to the server and a fresh render of this page, and on a phone that is long
  // enough to read as a switch that did not work. So the row shows where it is
  // going at once, and the database still decides where it ends up: the
  // optimistic value lasts only while the action runs, then gives way to
  // item.is_active from the page that came back. A refusal changed nothing, so
  // the switch falls back to where it was and the error says why.
  const [on, showOn] = useOptimistic(item.is_active);
  const [activity, toggleActive, switching] = useActionState(async (previous, formData) => {
    showOn(formData.get('active') === 'true');
    try {
      return await setMenuItemActiveAction(previous, formData);
    } catch {
      // The request never came back. Nothing is known to have saved.
      return { ok: false, message: 'That did not save. Please try again.' };
    }
  }, {});

  const soldOut = on && !item.is_available;

  return (
    <Card className={`p-3.5 sm:p-4 ${on ? '' : 'bg-surface-2/40'}`}>
      <div className="flex items-start gap-3">
        <button
          type="button"
          onClick={onToggleDetails}
          aria-expanded={expanded}
          className="press-sm min-w-0 flex-1 text-left"
        >
          <span className="flex items-baseline justify-between gap-3">
            <span className={`font-semibold break-words ${on ? '' : 'text-muted'}`}>
              {item.name}
            </span>
            <span className={`shrink-0 font-semibold tabular-nums ${on ? '' : 'text-muted'}`}>
              {priceSummary(item)}
            </span>
          </span>

          <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
            {soldOut ? <span className="text-warn font-semibold">Sold out</span> : null}
            {!on ? <span className="text-muted">Off the menu</span> : null}
            {/* KEPT, NOT SOLD. Its prices are all still here for when Campus
                Dash turns customer-chosen prices back on. */}
            {isVariablePrice(item) && !variablePricing ? (
              <span className="text-warn font-semibold">Hidden from customers</span>
            ) : null}
            {item.scan_eligible ? (
              <span className="bg-brand-50 text-brand-800 rounded px-1.5 py-0.5 font-semibold">
                Takes meal scans
              </span>
            ) : null}
            <span className="text-faint">{expanded ? 'Hide' : 'Details'}</span>
          </span>
        </button>

        {/* THE SWITCH. One tap, and it is the only control on the row a busy
            counter has to find. Turning the last one off closes the store, and
            the page says so on the next render. */}
        <form action={toggleActive} className="shrink-0">
          <input type="hidden" name="menu_item_id" value={item.id} />
          <input type="hidden" name="vendor_id" value={vendorId} />
          <input type="hidden" name="name" value={item.name} />
          {/* The SAVED state decides what a tap asks for, never the optimistic
              one; and the switch is disabled until the last tap is answered,
              so two taps cannot race each other to the database. */}
          <input type="hidden" name="active" value={item.is_active ? 'false' : 'true'} />
          <Switch on={on} pending={switching} label={item.name} />
        </form>
      </div>

      {activity.message && !activity.ok ? (
        <ErrorNote className="mt-2.5">{activity.message}</ErrorNote>
      ) : null}

      {expanded ? (
        <ItemDetails
          item={item}
          vendorId={vendorId}
          storeOpen={storeOpen}
          variablePricing={variablePricing}
          onDone={onToggleDetails}
        />
      ) : null}
    </Card>
  );
}

/**
 * A real switch, as a submit button.
 *
 * `role="switch"` and `aria-checked` rather than a styled checkbox: the control
 * submits a form, so it is a button, and a button that lies about its state to
 * a screen reader is worse than a plain one.
 */
function Switch({ on, pending, label }) {
  return (
    <button
      type="submit"
      role="switch"
      aria-checked={on}
      aria-label={`${label}: ${on ? 'on the menu' : 'off the menu'}`}
      disabled={pending}
      className={`press-sm relative inline-flex h-7 w-12 shrink-0 items-center rounded-full border transition-colors disabled:opacity-55 ${
        on ? 'bg-brand-600 border-brand-700' : 'bg-surface-3 border-line-strong'
      }`}
    >
      <span
        className={`bg-surface size-5 rounded-full shadow-sm transition-transform ${
          on ? 'translate-x-6' : 'translate-x-1'
        }`}
      />
    </button>
  );
}

/* ---------------------------------------------------------------------------
 * Details: sold out, edit, delete — revealed on tap
 * ------------------------------------------------------------------------ */

function ItemDetails({ item, vendorId, storeOpen, variablePricing, onDone }) {
  const [editing, setEditing] = useState(false);

  return (
    <div className="border-line animate-fade-up mt-3.5 border-t pt-3.5">
      {item.description ? (
        <p className="text-muted mb-3 text-sm leading-relaxed">{item.description}</p>
      ) : null}

      {editing ? (
        <EditItem
          item={item}
          vendorId={vendorId}
          variablePricing={variablePricing}
          onDone={() => setEditing(false)}
        />
      ) : (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {/* SOLD OUT ONLY MEANS ANYTHING FOR AN ITEM THAT IS ON. For one that
              is off, the customer is not looking at it either way. */}
          {item.is_active ? (
            <SoldOutButton item={item} vendorId={vendorId} storeOpen={storeOpen} />
          ) : null}

          <button
            type="button"
            onClick={() => setEditing(true)}
            className="text-muted hover:text-ink press-sm min-h-9 text-sm font-medium transition-colors"
          >
            Edit
          </button>

          <DeleteControl item={item} vendorId={vendorId} onDone={onDone} />
        </div>
      )}
    </div>
  );
}

function SoldOutButton({ item, vendorId, storeOpen }) {
  const [state, submit, pending] = useActionState(setMenuItemAvailableAction, {});
  const soldOut = !item.is_available;

  return (
    <div>
      <form action={submit}>
        <input type="hidden" name="menu_item_id" value={item.id} />
        <input type="hidden" name="vendor_id" value={vendorId} />
        <input type="hidden" name="name" value={item.name} />
        <input type="hidden" name="available" value={soldOut ? 'true' : 'false'} />
        <button
          type="submit"
          disabled={pending}
          className={`press-sm min-h-9 text-sm font-medium transition-colors disabled:opacity-55 ${
            soldOut ? 'text-brand-800' : 'text-muted hover:text-warn'
          }`}
        >
          {pending ? 'Saving…' : soldOut ? 'Available again' : 'Mark sold out'}
        </button>
      </form>
      {soldOut && storeOpen ? (
        <p className="text-faint mt-1 text-xs">Clears when you next open.</p>
      ) : null}
      {state.message && !state.ok ? <ErrorNote className="mt-2">{state.message}</ErrorNote> : null}
    </div>
  );
}

/**
 * DELETE IS ABSENT once anybody has ordered it. The server refuses it, and a
 * button that always fails is worse than no button — the row already carries
 * the count that decides this.
 */
function DeleteControl({ item, vendorId, onDone }) {
  const [state, remove, deleting] = useActionState(deleteMenuItemAction, {});
  const [confirming, setConfirming] = useState(false);
  const ordered = Number(item.order_count ?? 0) > 0;

  useEffect(() => {
    if (state.ok) onDone();
  }, [state.ok, onDone]);

  if (ordered) {
    return (
      <p className="text-faint text-xs">
        Ordered before, so it cannot be deleted. Turning it off does the same thing.
      </p>
    );
  }

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="text-muted hover:text-bad press-sm min-h-9 text-sm font-medium transition-colors"
      >
        Delete
      </button>
    );
  }

  return (
    <form action={remove} className="flex flex-wrap items-center gap-2">
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
      {state.message && !state.ok ? (
        <ErrorNote className="w-full">{state.message}</ErrorNote>
      ) : null}
    </form>
  );
}

/* ---------------------------------------------------------------------------
 * Adding and editing
 * ------------------------------------------------------------------------ */

function AddItem({ vendorId, variablePricing, onDone }) {
  const [state, submit, pending] = useActionState(createMenuItemAction, {});

  // The form is REPLACED on success rather than left filled in, which reads as
  // "nothing happened" and invites a second identical item.
  useEffect(() => {
    if (state.ok) onDone();
  }, [state.ok, onDone]);

  return (
    <Card className="border-brand-600 ring-brand-600/20 animate-fade-up mb-4 p-5 ring-1">
      <h3 className="font-semibold">Add an item</h3>
      <p className="text-muted mt-1 mb-4 text-sm">
        It joins your items switched off. Turn it on when you are serving it.
      </p>
      <form action={submit} className="space-y-4">
        <input type="hidden" name="vendor_id" value={vendorId} />
        <ItemFields variablePricing={variablePricing} />
        <div className="flex gap-2">
          <Button type="submit" pending={pending}>
            {pending ? 'Adding…' : 'Add item'}
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

function EditItem({ item, vendorId, variablePricing, onDone }) {
  const [state, submit, pending] = useActionState(updateMenuItemAction, {});

  return (
    <form action={submit} className="space-y-4">
      <input type="hidden" name="vendor_id" value={vendorId} />
      <input type="hidden" name="menu_item_id" value={item.id} />
      <ItemFields item={item} variablePricing={variablePricing} />
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
  );
}

/**
 * The fields an item has, shared by add and edit so the two cannot drift.
 *
 * HOW IT IS PRICED is asked only of a store Campus Dash has given
 * customer-chosen prices. Without it the form is exactly what it always was —
 * and a variable item kept from before shows no price field at all, because
 * the one it would show is not what anybody pays.
 */
function ItemFields({ item = null, variablePricing = false }) {
  const [mode, setMode] = useState(item?.pricing_mode ?? PRICING_MODE.FIXED);
  const dormant = isVariablePrice(item) && !variablePricing;
  const fixed = mode === PRICING_MODE.FIXED;

  return (
    <>
      <div className={`grid gap-4 ${fixed && !dormant ? 'sm:grid-cols-[1fr_9rem]' : ''}`}>
        <Field label="Name">
          <Input name="name" required maxLength={120} defaultValue={item?.name ?? ''} />
        </Field>
        {fixed && !dormant ? (
          <Field label="Price" hint="In cedis">
            <Input
              name="price"
              required
              inputMode="decimal"
              placeholder="35.00"
              defaultValue={item ? (item.price_pesewas / 100).toFixed(2) : ''}
            />
          </Field>
        ) : null}
      </div>

      {variablePricing ? (
        <fieldset>
          <legend className="mb-1.5 text-sm font-medium">Pricing</legend>
          <div className="flex gap-2">
            {[
              [PRICING_MODE.FIXED, 'One price'],
              [PRICING_MODE.STEPPED, 'Steps'],
              [PRICING_MODE.CHOICES, 'List'],
            ].map(([value, label]) => (
              <SegmentedOption
                key={value}
                name="pricing_mode"
                value={value}
                checked={mode === value}
                onChange={() => setMode(value)}
              >
                {label}
              </SegmentedOption>
            ))}
          </div>
        </fieldset>
      ) : null}

      {variablePricing && mode === PRICING_MODE.STEPPED ? <SteppedFields item={item} /> : null}
      {variablePricing && mode === PRICING_MODE.CHOICES ? <ChoiceFields item={item} /> : null}

      {/* A MEAL SCAN PAYS A SET PRICE, so only an item with one can take it. */}
      {fixed && !dormant ? (
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
      ) : null}
    </>
  );
}

function cedisOrEmpty(pesewas) {
  return pesewas == null ? '' : cedisInputFromPesewas(Number(pesewas)).replace(/\.00$/, '');
}

/**
 * A starting price, a step, and an optional maximum.
 *
 * CONTROLLED, ON PURPOSE. React resets a form's uncontrolled fields every time
 * its action runs — including when the server refuses the save — so a vendor
 * who got something wrong used to watch what they typed snap back to the old
 * values. Held in state, the fields keep what was typed until it is fixed.
 *
 * CHECKED AS THEY TYPE, by the same rule the server applies: the start and the
 * step are each any positive price, and only a maximum has to land on the
 * steps. When it does not, the nearest prices that do are named.
 */
function SteppedFields({ item }) {
  const [min, setMin] = useState(cedisOrEmpty(item?.variable_min_pesewas));
  const [step, setStep] = useState(cedisOrEmpty(item?.variable_step_pesewas));
  const [max, setMax] = useState(cedisOrEmpty(item?.variable_max_pesewas));

  const minPesewas = min.trim() ? parseCedis(min) : null;
  const stepPesewas = step.trim() ? parseCedis(step) : null;
  const maxPesewas = max.trim() ? parseCedis(max) : null;

  let problem = null;
  if (min.trim() && minPesewas === null) problem = 'The starting price must be a number, like 10.';
  else if (step.trim() && stepPesewas === null) problem = 'The step must be a number, like 5.';
  else if (max.trim() && maxPesewas === null) problem = 'The maximum must be a number, or empty.';
  else if (minPesewas !== null && stepPesewas !== null) {
    const rule = checkSteppedRule({ minPesewas, stepPesewas, maxPesewas });
    if (!rule.ok) problem = rule.message;
  }
  const ready = !problem && minPesewas > 0 && stepPesewas > 0;

  return (
    <div>
      <div className="grid grid-cols-3 gap-3">
        <Field label="From">
          <Input
            name="variable_min"
            required
            inputMode="decimal"
            placeholder="10"
            value={min}
            onChange={(event) => setMin(event.target.value)}
          />
        </Field>
        <Field label="Step">
          <Input
            name="variable_step"
            required
            inputMode="decimal"
            placeholder="5"
            value={step}
            onChange={(event) => setStep(event.target.value)}
          />
        </Field>
        <Field label="Up to" hint="Empty for no limit">
          <Input
            name="variable_max"
            inputMode="decimal"
            placeholder="None"
            value={max}
            onChange={(event) => setMax(event.target.value)}
          />
        </Field>
      </div>
      {problem ? (
        <p className="text-bad mt-2 text-sm" role="status">
          {problem}
        </p>
      ) : ready ? (
        <p className="text-muted mt-2 text-sm tabular-nums">
          {steppedPreview({ minPesewas, stepPesewas, maxPesewas })}
        </p>
      ) : null}
    </div>
  );
}

/**
 * A list of exact prices.
 *
 * A TEXT KEYBOARD, because the list is separated by commas and a phone's
 * number pad has none. Spaces work as separators too.
 */
function ChoiceFields({ item }) {
  const [text, setText] = useState(
    item?.variable_choices_pesewas
      ? priceChoices(item)
          .map((p) => cedisOrEmpty(p))
          .join(', ')
      : ''
  );
  const list = text.trim() ? parsePriceList(text) : null;

  return (
    <Field label="Prices" hint="In cedis, separated by commas">
      <Input
        name="variable_choices"
        required
        type="text"
        inputMode="text"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        enterKeyHint="done"
        placeholder="10, 15, 30, 50"
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      {list && !list.ok ? (
        <span className="text-bad mt-1.5 block text-sm" role="status">
          {list.message}
        </span>
      ) : null}
    </Field>
  );
}
