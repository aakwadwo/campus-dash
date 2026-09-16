'use client';

import { useActionState, useState } from 'react';
import { settlePayoutManuallyAction } from '../actions';
import { Panel, Badge, Empty, Unavailable, Table, Row, Cell, Cedis, Button, when } from '../ui';

/**
 * The weekly Partner payout, done by hand.
 *
 * WHY THIS SCREEN EXISTS. Partner money sits in the Campus Dash balance and an
 * administrator sends it at the end of each week. That was already how it
 * worked, but only because an environment variable was switched off — the run
 * called sendTransfer() for Partners and was stopped by configuration. It is
 * the design now: the run creates payouts and stops, and this is where somebody
 * records what they actually sent.
 *
 * THE REFERENCE IS REQUIRED, and the database refuses without one. A manual
 * settlement has no provider event behind it, so the MoMo transaction id the
 * operator types is the only thing linking this row to a real transfer. A
 * record saying money moved with no way to check it is worse than no record.
 *
 * ARMED IN TWO STEPS, deliberately. Marking a payout paid clears a real
 * liability and cannot be undone from this screen, so it does not sit one click
 * from a mis-tap on a table row.
 */
export default function ManualSettlement({ payouts }) {
  const outstanding = (payouts ?? []).filter((p) => p.status !== 'PAID');
  const total = outstanding.reduce((sum, p) => sum + Number(p.amount_pesewas ?? 0), 0);

  return (
    <Panel
      title="Partners waiting to be paid"
      description={
        outstanding.length
          ? `${outstanding.length} to send, ${formatTotal(total)} in total. Send the money, then record each one.`
          : 'Everything from the last run has been recorded.'
      }
    >
      {payouts === null ? (
        <Unavailable>The payout list could not be loaded.</Unavailable>
      ) : outstanding.length === 0 ? (
        <Empty>Nobody is waiting. Run the weekly Partner payout to gather what is owed.</Empty>
      ) : (
        <Table head={['Partner', 'Period', 'Deliveries', 'Send to', 'Amount', '']} minWidth="52rem">
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

  const paid = state.ok;

  return (
    <Row>
      <Cell>
        {payout.payee_name ?? '—'}
        <span className="text-faint block font-mono text-xs">{payout.payee_phone}</span>
      </Cell>
      <Cell muted>
        {when(payout.period_start)} – {when(payout.period_end)}
        {payout.status === 'FAILED' ? (
          <span className="mt-1 block">
            <Badge tone="bad">a transfer failed</Badge>
          </span>
        ) : null}
      </Cell>
      <Cell numeric>{payout.deliveries}</Cell>
      <Cell>
        {payout.momo_network ? (
          <>
            {payout.momo_network}
            {/* THE LAST THREE DIGITS ONLY. An operator needs to recognise the
                destination, not to be able to read a full account number off a
                screen in a shared office. */}
            <span className="text-faint block font-mono text-xs">
              ···{payout.account_last3} · {payout.account_name}
            </span>
          </>
        ) : (
          <Badge tone="warn">no destination on file</Badge>
        )}
      </Cell>
      <Cell numeric>
        <Cedis pesewas={payout.amount_pesewas} />
      </Cell>
      <Cell>
        {paid ? (
          <Badge tone="good">Recorded</Badge>
        ) : arming ? (
          <form action={settle} className="flex flex-wrap items-center gap-2">
            <input type="hidden" name="payout_id" value={payout.payout_id} />
            <input
              name="reference"
              required
              placeholder="MoMo reference"
              className="border-line-strong w-40 rounded border px-2 py-1 text-xs"
            />
            <Button pending={pending}>{pending ? 'Recording…' : 'Mark paid'}</Button>
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
            title={payout.momo_network ? undefined : 'Set a payout destination first'}
          >
            I have sent this
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
