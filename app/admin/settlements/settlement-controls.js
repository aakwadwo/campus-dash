'use client';

import { useActionState } from 'react';
import { runSettlementAction } from '../actions';
import { Panel, Button, ActionResult } from '../ui';

/**
 * Gathering what is owed into payouts.
 *
 * NEITHER BUTTON PAYS ANYBODY while `transfersOn` is false, and the labels say
 * so. A run claims what is owed for its period into PENDING payouts, which then
 * wait in the panels below for an administrator to pay externally and record.
 * Stores paid by Paystack split never appear in a run at all.
 *
 * Safe to press twice: the run for a period is returned rather than recreated,
 * its allocations are already claimed, and one payout per payee per run is a
 * unique index.
 */
export default function SettlementControls({ transfersOn }) {
  const [state, run, running] = useActionState(runSettlementAction, {});

  return (
    <Panel
      title="Gather payouts"
      description="Pressing twice for the same period gathers nobody twice."
    >
      <div className="flex flex-wrap gap-3">
        <form action={run}>
          <input type="hidden" name="payee_type" value="PARTNER" />
          <Button disabled={running}>
            {running ? 'Gathering…' : "Gather last week's Partner payouts"}
          </Button>
        </form>
        <form action={run}>
          <input type="hidden" name="payee_type" value="VENDOR" />
          <Button variant="secondary" disabled={running}>
            {running
              ? 'Gathering…'
              : transfersOn
                ? 'Transfer to stores without a split'
                : 'Gather payouts for stores without a split'}
          </Button>
        </form>
      </div>
      <ActionResult state={state} />
      <p className="text-muted mt-3 text-xs leading-relaxed">
        The Partner week runs Sunday to Saturday. Gathering it sends nothing: it lists who has
        reached the payout threshold and how much, for you to pay by mobile money and record. Anyone
        under the threshold stays owed and carries into the next week.
      </p>
      <p className="text-muted mt-2 text-xs leading-relaxed">
        {transfersOn
          ? 'Stores without a Paystack split are paid by transfer from the Campus Dash balance. A transfer Paystack accepts is PROCESSING until its own success event arrives.'
          : 'Paystack transfers are off on this deployment, so stores without a Paystack split are gathered the same way as Partners: nothing is sent until you pay them yourself and record it.'}
      </p>
    </Panel>
  );
}
