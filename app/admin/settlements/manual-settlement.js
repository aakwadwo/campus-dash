'use client';

import { useActionState, useState } from 'react';
import { settlePayoutManuallyAction } from '../actions';
import { Panel, Badge, Empty, Unavailable, Table, Row, Cell, Cedis, Button, when } from '../ui';

/**
 * Payouts an administrator pays OUTSIDE Campus Dash, and records here.
 *
 * NOTHING ON THIS PANEL MOVES MONEY. Campus Dash cannot send a Partner — or a
 * store without a Paystack split — their money on this deployment: transfers
 * are off. A run gathers what is owed into a payout and stops. A person sends
 * the mobile money from their own phone or the Paystack dashboard, then records
 * it here with the reference, and only that record makes the payout PAID and
 * closes the earnings it covers.
 *
 * THE REFERENCE IS REQUIRED, and the database refuses without one. A manual
 * settlement has no provider event behind it, so the MoMo transaction id the
 * operator types is the only thing linking this row to a real payment.
 *
 * ONLY PENDING PAYOUTS ARE OFFERED. A payout that FAILED released what it
 * covered back to "owed", and admin_settle_payout_manually() refuses it — so a
 * record button on it could only ever fail. That money is gathered again by the
 * next run and appears here then.
 *
 * ARMED IN TWO STEPS, deliberately. Recording clears a real liability and
 * cannot be undone from this screen, so it does not sit one mis-tap away.
 */
export default function ManualSettlement({ title, payouts, payeeLabel, countLabel, emptyText }) {
  const outstanding = (payouts ?? []).filter(
    (p) => p.status === 'PENDING' || p.status === 'PROCESSING'
  );
  const total = outstanding.reduce((sum, p) => sum + Number(p.amount_pesewas ?? 0), 0);

  return (
    <Panel
      title={title}
      description={
        outstanding.length
          ? `${outstanding.length} to pay, ${formatTotal(total)} in total. Campus Dash does not send this money. Pay each one by mobile money yourself, then record it with the transaction reference.`
          : 'Nothing gathered is waiting to be paid.'
      }
    >
      {payouts === null ? (
        <Unavailable>The payout list could not be loaded.</Unavailable>
      ) : outstanding.length === 0 ? (
        <Empty>{emptyText}</Empty>
      ) : (
        <Table head={[payeeLabel, 'Period', countLabel, 'Pay to', 'Amount', '']} minWidth="52rem">
          {outstanding.map((payout) => (
            <PayoutRow key={payout.payout_id} payout={payout} />
          ))}
        </Table>
      )}
    </Panel>
  );
}

function PayoutRow({ payout }) {
  const [state, settle, pending] = useActionState(settlePayoutManuallyAction, {});
  const [arming, setArming] = useState(false);

  const recorded = state.ok;

  return (
    <Row>
      <Cell>
        {payout.payee_name ?? '—'}
        {payout.payee_phone ? (
          <span className="text-faint block font-mono text-xs">{payout.payee_phone}</span>
        ) : null}
      </Cell>
      <Cell muted>
        {when(payout.period_start)} – {when(payout.period_end)}
      </Cell>
      <Cell numeric>{payout.deliveries}</Cell>
      <Cell>
        {payout.momo_network ? (
          <>
            {payout.momo_network}
            {/* THE LAST THREE DIGITS ONLY. An operator needs to recognise the
                destination, not to read a full account number off a screen in
                a shared office. */}
            <span className="text-faint block font-mono text-xs">
              ···{payout.account_last3} · {payout.account_name}
            </span>
          </>
        ) : (
          <Badge tone="warn">no MoMo details on file</Badge>
        )}
      </Cell>
      <Cell numeric>
        <Cedis pesewas={payout.amount_pesewas} />
      </Cell>
      <Cell>
        {recorded ? (
          <Badge tone="good">Recorded as paid</Badge>
        ) : arming ? (
          <form action={settle} className="flex flex-wrap items-center gap-2">
            <input type="hidden" name="payout_id" value={payout.payout_id} />
            <input
              name="reference"
              required
              placeholder="MoMo transaction ID"
              aria-label="Mobile money transaction ID of the payment you made"
              className="border-line-strong w-44 rounded border px-2 py-1 text-xs"
            />
            <Button pending={pending}>{pending ? 'Recording…' : 'Record payment'}</Button>
            <button
              type="button"
              onClick={() => setArming(false)}
              className="text-muted text-xs underline"
            >
              Cancel
            </button>
          </form>
        ) : (
          <button
            type="button"
            onClick={() => setArming(true)}
            disabled={!payout.momo_network}
            className="text-brand-700 press-sm min-h-8 rounded px-2 text-xs font-semibold disabled:opacity-45"
            title={payout.momo_network ? undefined : 'Add their MoMo details first'}
          >
            I have paid this externally
          </button>
        )}
        {state.message && !state.ok ? (
          <p role="alert" className="text-bad mt-1 text-xs">
            {state.message}
          </p>
        ) : null}
      </Cell>
    </Row>
  );
}

function formatTotal(pesewas) {
  return `GH₵${(Number(pesewas ?? 0) / 100).toFixed(2)}`;
}
