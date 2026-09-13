/**
 * Keeps SMS copy inside the GSM 03.38 alphabet.
 *
 * WHY THIS EXISTS. A single character outside that alphabet switches the WHOLE
 * message to UCS-2: the segment shrinks from 160 characters to 70, and the text
 * travels as Unicode through every hop between Arkesel and a Ghanaian handset.
 * The store's NEW PAID ORDER message carried one em dash, and it was accepted by
 * Arkesel ("ok") and never arrived, while the approval SMS sent to the same
 * number five minutes earlier, with the same link and no em dash, did. Nothing
 * in the database or the provider response distinguishes the two; the encoding
 * does.
 *
 * So typographic punctuation is folded to its plain equivalent at the point copy
 * is rendered. The templates stay as they are written; what goes to the provider
 * is the version a basic phone network carries as ordinary text.
 *
 * Only characters with an obvious plain form are replaced. A store or dish name
 * in another script is left alone: changing somebody's name is worse than
 * spending a second segment on it.
 *
 * Relative imports only, so the plain Node test runner can load it.
 */

const BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
// Escape-table characters. Still GSM-7; each costs two septets.
const EXTENSION = '\f^{}\\[~]|€';

const GSM7 = new Set([...BASIC, ...EXTENSION]);

const SUBSTITUTES = [
  // The cedi sign is not in the alphabet. formatPesewas() writes "GH₵5.00".
  [/GH₵/g, 'GHS '],
  [/₵/g, 'GHS '],
  [/[‒–—―−]/g, '-'],
  [/[‘’‚′]/g, "'"],
  [/[“”„″]/g, '"'],
  [/…/g, '...'],
  [/×/g, 'x'],
  [/[   ]/g, ' '],
];

export function toGsm7(text) {
  if (typeof text !== 'string') return text;
  return SUBSTITUTES.reduce((out, [pattern, plain]) => out.replace(pattern, plain), text);
}

export function isGsm7(text) {
  return [...String(text)].every((ch) => GSM7.has(ch));
}
