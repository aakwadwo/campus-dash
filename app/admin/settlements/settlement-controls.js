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
      description="Idempotent — pressing twice for the same period pays nobody twice."
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
            {running ? 'Running…' : 'Run Partner payouts (weekly)'}
          </Button>
        </form>
      </div>
      <ActionResult state={state} />
      <p className="text-muted mt-3 text-xs">
        A payout the provider accepts is PROCESSING, not paid. It becomes PAID only when the
        provider&apos;s transfer event says the money arrived. A failed transfer releases what is
        owed back into the next run, and is retried only when you press retry.
      </p>
    </Panel>
  );
}
