/**
 * The Partner payday, as rules with no I/O, so the admin reminder, the run and
 * the tests all read the same week the same way.
 *
 * THE WEEK IS SUNDAY TO SATURDAY, Accra time, which is UTC all year. It ends at
 * Sunday 00:00, and Sunday is when Campus Dash pays Partners — by hand, outside
 * the app. Nothing here marks anybody paid. Reaching Sunday only means a
 * payment is DUE; a payout is paid when an administrator records paying it.
 */

/** The Partner week that ended most recently, as { periodStart, periodEnd }. */
export function partnerWeek(now = new Date()) {
  const end = new Date(now);
  end.setUTCHours(0, 0, 0, 0);
  end.setUTCDate(end.getUTCDate() - end.getUTCDay());
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 7);
  return { periodStart: start.toISOString(), periodEnd: end.toISOString() };
}

/** Sunday in Accra. */
export function isPayday(now = new Date()) {
  return new Date(now).getUTCDay() === 0;
}

/**
 * Who is owed for the week that just ended, and has not been gathered yet.
 *
 * The same claim create_settlement_run() makes: a Partner allocation that is
 * ELIGIBLE, not already on a payout, from an order placed before the week
 * ended. Only a Partner whose total reaches the threshold is due; anybody under
 * it stays owed and carries into next week, exactly as the run holds them.
 *
 * `allocations` are rows of { payee_id, amount_pesewas, status,
 * settlement_run_id, order_created_at }; `partners` are { partner_id,
 * partner_name } for naming them.
 */
export function partnersDue({ allocations, partners, thresholdPesewas, now = new Date() }) {
  const { periodEnd } = partnerWeek(now);
  const cutoff = new Date(periodEnd).getTime();
  const owed = new Map();

  for (const a of allocations ?? []) {
    if (a.status !== 'ELIGIBLE' || a.settlement_run_id) continue;
    if (!a.order_created_at || new Date(a.order_created_at).getTime() >= cutoff) continue;
    owed.set(a.payee_id, (owed.get(a.payee_id) ?? 0) + Number(a.amount_pesewas));
  }

  return [...owed]
    .filter(([, pesewas]) => pesewas >= thresholdPesewas)
    .map(([partnerId, pesewas]) => ({
      partnerId,
      partnerName: (partners ?? []).find((p) => p.partner_id === partnerId)?.partner_name ?? null,
      owedPesewas: pesewas,
    }))
    .sort((a, b) => b.owedPesewas - a.owedPesewas);
}
