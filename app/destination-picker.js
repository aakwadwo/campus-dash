'use client';

import { useMemo, useState } from 'react';
import { ArrowLeftIcon, CheckIcon, ChevronRightIcon, PinIcon } from './ui';

/**
 * Where a Campus Dash Partner should bring an order.
 *
 * RECOGNISABLE PLACES FIRST, PRECISION ONLY ON REQUEST. The first screen is a
 * handful of places everybody knows — Academic Block, Hostel A, Sports &
 * recreation. Opening one shows its floors (or its landmarks); a floor is a
 * complete answer, and its rooms appear underneath only as an optional extra.
 * Somebody in a corridor, a common room or on the stairs is never made to
 * invent a room to get past the form.
 *
 * A HOSTEL OPENS ON ITS ENTRANCE. Somebody who says "Hostel A" and nothing
 * more is met at the door, so that is selected the moment the hostel is
 * opened, and a floor or room refines it.
 *
 * Nothing here decides what may be chosen. `places` comes from
 * destination_places(), and submission re-checks the id is an active,
 * deliverable location. The label shown is the label the order will carry.
 */
export default function DestinationPicker({ places, value, onChange, name = null }) {
  const tree = useMemo(() => buildTree(places ?? []), [places]);
  const chain = value ? tree.chain(value) : [];
  const [openId, setOpenId] = useState(chain[0]?.location_id ?? null);
  const open = openId ? tree.byId.get(openId) : null;
  const selected = value ? tree.byId.get(value) : null;

  function openTop(place) {
    const inside = tree.offered(place.location_id);
    if (!inside.length) {
      // A place with nothing below it is the answer on its own.
      onChange(place.location_id);
      setOpenId(null);
      return;
    }
    setOpenId(place.location_id);
    if (value && tree.chain(value)[0]?.location_id === place.location_id) return;
    onChange(defaultFor(place, inside));
  }

  function back() {
    setOpenId(null);
  }

  return (
    <div>
      {name ? <input type="hidden" name={name} value={value ?? ''} /> : null}

      {selected ? (
        <p className="text-ink mb-3 flex items-start gap-2 font-medium" aria-live="polite">
          <PinIcon className="text-brand-700 mt-0.5 size-5 shrink-0" />
          <span>{selected.label}</span>
        </p>
      ) : null}

      {!open ? (
        <ul className="border-line divide-line rounded-card divide-y overflow-hidden border">
          {tree.top.map((place) => {
            const isChosen = chain[0]?.location_id === place.location_id;
            return (
              <li key={place.location_id}>
                <button
                  type="button"
                  onClick={() => openTop(place)}
                  aria-pressed={isChosen}
                  className={`press-sm flex min-h-14 w-full items-center gap-3 px-4 text-left transition-colors ${
                    isChosen ? 'bg-brand-50' : 'hover:bg-surface-2'
                  }`}
                >
                  <span className="flex-1 font-medium">{place.name}</span>
                  {tree.offered(place.location_id).length ? (
                    <ChevronRightIcon className="text-faint size-5 shrink-0" />
                  ) : isChosen ? (
                    <CheckIcon className="text-brand-700 size-5 shrink-0" />
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <div>
          <button
            type="button"
            onClick={back}
            className="text-muted hover:text-ink press-sm mb-2 -ml-2 inline-flex min-h-11 items-center gap-1.5 rounded-full pr-3 pl-2 text-sm font-medium"
          >
            <ArrowLeftIcon className="size-4" />
            All places
          </button>
          <h4 className="mb-2.5 font-semibold">{open.name}</h4>

          <ul className="border-line divide-line rounded-card divide-y overflow-hidden border">
            {tree.offered(open.location_id).map((place) => {
              const inChain = chain.some((node) => node.location_id === place.location_id);
              const rooms = tree.offered(place.location_id);
              const expanded = inChain && rooms.length > 0;
              return (
                <li key={place.location_id}>
                  <button
                    type="button"
                    onClick={() => {
                      if (place.is_deliverable) onChange(place.location_id);
                      else if (rooms.length) onChange(defaultFor(place, rooms));
                    }}
                    aria-pressed={value === place.location_id}
                    className={`press-sm flex min-h-14 w-full items-center gap-3 px-4 text-left transition-colors ${
                      inChain ? 'bg-brand-50' : 'hover:bg-surface-2'
                    }`}
                  >
                    <span className="flex-1 font-medium">{shortName(place, open)}</span>
                    {inChain ? <CheckIcon className="text-brand-700 size-5 shrink-0" /> : null}
                  </button>

                  {expanded ? (
                    <div className="bg-brand-50 px-4 pb-4">
                      <p className="text-muted mb-2 text-sm">Room (optional)</p>
                      <RoomChoice
                        rooms={rooms}
                        value={value}
                        onChange={(id) =>
                          onChange(id === value && place.is_deliverable ? place.location_id : id)
                        }
                      />
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * Rooms. A grid when every name is short (C1…C32), so thirty-two of them fit
 * on a phone without scrolling past the Pay button; wrapped pills otherwise
 * ("Computer Lab 1" does not fit in a grid cell). Tapping the chosen room again
 * goes back to the floor.
 */
function RoomChoice({ rooms, value, onChange }) {
  const compact = rooms.every((room) => room.name.length <= 4);
  return (
    <div className={compact ? 'grid grid-cols-6 gap-2 sm:grid-cols-8' : 'flex flex-wrap gap-2'}>
      {rooms.map((room) => {
        const on = room.location_id === value;
        return (
          <button
            key={room.location_id}
            type="button"
            onClick={() => onChange(room.location_id)}
            aria-pressed={on}
            className={`rounded-input press-sm min-h-11 border text-sm font-medium tabular-nums transition-colors ${
              compact ? '' : 'px-3.5'
            } ${
              on
                ? 'border-brand-700 bg-brand-700 text-white'
                : 'border-line-strong bg-surface hover:bg-surface-2'
            }`}
          >
            {room.name}
          </button>
        );
      })}
    </div>
  );
}

/** "Hostel A Entrance" reads as "Entrance" inside Hostel A. */
function shortName(place, parent) {
  const prefix = `${parent.name} `;
  return place.name.startsWith(prefix) ? place.name.slice(prefix.length) : place.name;
}

/** What opening a place selects before the customer taps anything else. */
function defaultFor(place, inside) {
  if (place.is_deliverable) return place.location_id;
  const entrance = inside.find(
    (child) => child.kind === 'COMMON_AREA' && child.name.startsWith(`${place.name} `)
  );
  return entrance?.location_id ?? null;
}

function buildTree(rows) {
  const byId = new Map(rows.map((row) => [row.location_id, row]));
  const children = new Map();
  for (const row of rows) {
    if (!row.parent_id || !byId.has(row.parent_id)) continue;
    if (!children.has(row.parent_id)) children.set(row.parent_id, []);
    children.get(row.parent_id).push(row);
  }
  for (const list of children.values()) {
    list.sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));
  }

  // Does anything at or below this place accept a destination?
  const reachable = new Map();
  const reaches = (id) => {
    if (reachable.has(id)) return reachable.get(id);
    reachable.set(id, false);
    const node = byId.get(id);
    const result =
      Boolean(node?.is_deliverable) || (children.get(id) ?? []).some((c) => reaches(c.location_id));
    reachable.set(id, result);
    return result;
  };

  const offered = (id) => (children.get(id) ?? []).filter((c) => reaches(c.location_id));

  const top = rows
    .filter((row) => row.kind === 'CAMPUS' && !row.parent_id)
    .flatMap((campus) => offered(campus.location_id));

  // The path from a top-level place down to `id`, campus excluded.
  const chain = (id) => {
    const path = [];
    let node = byId.get(id);
    while (node && node.kind !== 'CAMPUS') {
      path.unshift(node);
      node = byId.get(node.parent_id);
    }
    return path;
  };

  return { byId, top, offered, chain };
}
