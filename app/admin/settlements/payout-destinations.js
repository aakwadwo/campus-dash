'use client';

import { useActionState } from 'react';
import { setPayoutDestinationAction } from '../actions';
import { Panel, Button, ActionResult, Empty } from '../ui';

const NETWORKS = ['MTN', 'VODAFONE', 'AIRTELTIGO'];

/**
 * Where settlement money goes.
 *
 * A phone number is not enough to send mobile money: the network and the name
 * on the account matter, and the provider issues a recipient code that later
 * transfers refer to. That code is shown, because "not registered yet" is the
 * difference between a payout that can leave and one that cannot.
 *
 * Changing the number clears the code, so a corrected destination cannot keep
 * paying the old one.
 */
export default function PayoutDestinations({ destinations }) {
  const [state, save, saving] = useActionState(setPayoutDestinationAction, {});

  return (
    <Panel
      title="Payout destinations"
      description="Mobile money accounts settlement transfers are sent to. Server-only — no client role can read this table."
    >
      {destinations?.length ? (
        <div className="mb-6 overflow-x-auto">
          <table className="w-full min-w-[40rem] text-sm">
            <thead className="text-muted text-left text-xs uppercase">
              <tr>
                <th className="pb-2 font-medium">Payee</th>
                <th className="pb-2 font-medium">Network</th>
                <th className="pb-2 font-medium">Number</th>
                <th className="pb-2 font-medium">Name on account</th>
                <th className="pb-2 font-medium">Registered</th>
              </tr>
            </thead>
            <tbody>
              {destinations.map((row) => (
                <tr key={`${row.payee_type}:${row.payee_id}`} className="border-t border-black/5">
                  <td className="py-2">
                    {row.payee_name}
                    <span className="text-muted ml-2 text-xs">{row.payee_type}</span>
                  </td>
                  <td className="py-2">{row.momo_network}</td>
                  <td className="py-2 font-mono text-xs tabular-nums">{row.account_number}</td>
                  <td className="py-2">{row.account_name}</td>
                  <td className="text-muted py-2 font-mono text-xs">
                    {row.provider_recipient_code ?? 'not registered yet'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty>No payout destinations set. Nothing can be transferred until there is one.</Empty>
      )}

      <form action={save} className="grid gap-3 sm:grid-cols-2">
        <Field label="Payee type">
          <select name="payee_type" required className={INPUT}>
            <option value="VENDOR">Vendor</option>
            <option value="PARTNER">Partner</option>
          </select>
        </Field>
        <Field label="Payee id">
          <input name="payee_id" required placeholder="uuid" className={INPUT} />
        </Field>
        <Field label="Network">
          <select name="momo_network" required className={INPUT}>
            {NETWORKS.map((network) => (
              <option key={network} value={network}>
                {network}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Mobile money number">
          <input name="account_number" required placeholder="0551234567" className={INPUT} />
        </Field>
        <Field label="Name on the account">
          <input name="account_name" required className={INPUT} />
        </Field>
        <Field label="Reason">
          <input name="reason" required placeholder="why this changed" className={INPUT} />
        </Field>
        <div className="sm:col-span-2">
          <Button disabled={saving}>{saving ? 'Saving…' : 'Save destination'}</Button>
        </div>
      </form>
      <ActionResult state={state} />
    </Panel>
  );
}

const INPUT =
  'mt-1 w-full rounded-lg border border-black/15 bg-white px-3 py-2 text-sm outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-600/50';

function Field({ label, children }) {
  return (
    <label className="block">
      <span className="text-xs font-medium">{label}</span>
      {children}
    </label>
  );
}
