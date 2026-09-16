'use client';

import { useActionState } from 'react';
import { runSettlementAction } from '../actions';
import { Panel, Button, ActionResult } from '../ui';

/**
 * Running a batch is safe to press twice: the run for a period is returned
 * rather than recreated, its allocations are already claimed, and its payouts
 * are already on their way. That property is what makes a button acceptable
 * here at all.
 */
export default function SettlementControls() {
  const [state, run, running] = useActionState(runSettlementAction, {});

  return (
    <Panel
      title="Run a settlement"
      description="Idempotent: pressing twice for the same period pays nobody twice."
    >
      <div className="flex flex-wrap gap-3">
        <form action={run}>
          <input type="hidden" name="payee_type" value="VENDOR" />
          <Button disabled={running}>
            {running ? 'Running…' : 'Run vendor settlement (daily)'}
          </Button>
        </form>
        <form action={run}>
          <input type="hidden" name="payee_type" value="PARTNER" />
          <Button variant="secondary" disabled={running}>
            {running ? 'Running…' : 'Gather Partner payouts (weekly)'}
          </Button>
        </form>
      </div>
      <ActionResult state={state} />
      <p className="text-muted mt-3 text-xs leading-relaxed">
        A VENDOR payout the provider accepts is PROCESSING, not paid: it becomes PAID only when the
        provider&apos;s transfer event says the money arrived, and a failed transfer releases what
        is owed back into the next run.
      </p>
      <p className="text-muted mt-2 text-xs leading-relaxed">
        A PARTNER run sends nothing. It gathers what is owed into payouts and stops — you send the
        money yourself and record each one below. A Partner under the weekly minimum is held, still
        owed, and swept into a later run.
      </p>
    </Panel>
  );
}
