/**
 * What Paystack's signed charge.success says happened to a split, for one store.
 *
 * `shares` is the event's `data.split.shares`; `subaccountCode` the store's
 * subaccount on the payment; `vendorSharePesewas` what the ledger says the store
 * is owed. Everything comes from Paystack's record — nothing is computed from
 * our own figures — and every value is null when there is no record to read.
 *
 * `confirmed` is true only when the record lists the store's subaccount
 * receiving its whole share. It says nothing about the money later reaching
 * the store's mobile money account, which Paystack does not report here.
 */
export function splitRecord(shares, subaccountCode, vendorSharePesewas) {
  const share = (shares?.subaccounts ?? []).find((s) => s.subaccount_code === subaccountCode);
  const num = (value) => (value === null || value === undefined ? null : Number(value));
  const subaccountCreditPesewas = share ? num(share.amount) : null;
  return {
    subaccountCreditPesewas,
    paystackFeePesewas: shares ? num(shares.paystack) : null,
    campusDashNetPesewas: shares ? num(shares.integration) : null,
    vendorFeePesewas: share ? num(share.fees ?? 0) : null,
    confirmed:
      subaccountCreditPesewas !== null && subaccountCreditPesewas === Number(vendorSharePesewas),
  };
}
