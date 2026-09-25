/**
 * Where a store says it is, relative to Academic City.
 *
 * Two facts: ON or OFF campus, and the vendor's own words for where exactly.
 * Free text on purpose. A campus stall and a kitchen in East Legon Hills do not
 * fit one address format, and a customer only needs enough to recognise it.
 *
 * Either can be missing on a store that registered before the question was
 * asked. Missing means "not said yet", never a guessed value.
 */

export const LOCATION_AREAS = Object.freeze([
  {
    value: 'ON_CAMPUS',
    label: 'On campus',
    placeholder: 'Block B, Ground Floor, near the Student Centre',
  },
  {
    value: 'OFF_CAMPUS',
    label: 'Off campus',
    placeholder: 'East Legon Hills, near the Academic City entrance',
  },
]);

/** The database's limit on the free text, so the form can say it first. */
export const LOCATION_DETAILS_MAX = 160;

export function locationAreaLabel(area) {
  return LOCATION_AREAS.find((a) => a.value === area)?.label ?? null;
}

/**
 * The line a customer reads under the store's name, or null when the store
 * has said nothing. "On campus · Block B, Ground Floor". Either half alone is
 * still shown, because an older store may have only one of them.
 */
export function vendorLocationLine(vendor) {
  const area = locationAreaLabel(vendor?.location_area);
  const details = vendor?.location_details?.trim() || null;
  const line = [area, details].filter(Boolean).join(' · ');
  return line || null;
}

/** Whether a store has told customers where it is. */
export function hasVendorLocation(vendor) {
  return Boolean(locationAreaLabel(vendor?.location_area) && vendor?.location_details?.trim());
}

/**
 * Reads and checks the two fields from a form. The database checks them again;
 * this is so the vendor hears about a mistake before a round trip.
 */
export function readVendorLocation(formData) {
  const area = String(formData.get('location_area') ?? '');
  const details = String(formData.get('location_details') ?? '').trim();

  if (!locationAreaLabel(area)) {
    return { ok: false, area, details, message: 'Say whether your store is on or off campus.' };
  }
  if (!details) {
    return { ok: false, area, details, message: 'Say where your store is.' };
  }
  if (details.length > LOCATION_DETAILS_MAX) {
    return {
      ok: false,
      area,
      details,
      message: `Keep the location under ${LOCATION_DETAILS_MAX} characters.`,
    };
  }
  return { ok: true, area, details };
}
