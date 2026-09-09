import { getMyRewardProgress } from '@/lib/customer';

/**
 * Progress towards the Campus Dash order goal.
 *
 * SMALL ON PURPOSE. It is one line of text and a hairline bar, and it sits
 * under the order list rather than above it — a loyalty tracker that takes up
 * more room than the orders it counts has misjudged what the product is for.
 *
 * WHAT IT DOES NOT SAY. It never names a reward, because Campus Dash has not
 * decided what the reward is and a screen that promises a free lunch creates an
 * obligation nobody agreed to. It says the goal has been reached and that the
 * team will be in touch, which is the true and complete statement.
 *
 * The number is a COUNT of completed orders, read straight from the database.
 * There is no points balance to keep in step and nothing that can double-count:
 * a cancelled order is not COMPLETED, so it is not in the count, and there is
 * no second record for it to be missing from.
 */
export default async function RewardProgress({ className = '' }) {
  let progress;
  try {
    progress = await getMyRewardProgress();
  } catch {
    // A tracker is the least important thing on any screen it appears on.
    return null;
  }

  if (!progress) return null;

  const done = Number(progress.completed_orders ?? 0);
  const goal = Number(progress.goal_orders ?? 0);
  if (goal <= 0) return null;

  // Nothing to show somebody who has never completed an order. A progress bar
  // at zero is a chore presented before anything has happened.
  if (done === 0 && !progress.reward_unlocked) return null;

  const marks = (progress.milestones ?? []).map(Number);
  const reached = new Set((progress.milestones_reached ?? []).map(Number));
  const percent = Math.min(100, Math.round((Math.min(done, goal) / goal) * 100));

  return (
    <section className={`border-line rounded-panel bg-surface border px-5 py-4 ${className}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-sm font-semibold">
          {progress.reward_unlocked ? 'Campus Dash reward unlocked' : 'Campus Dash rewards'}
        </h2>
        <p className="text-muted text-xs tabular-nums">
          {done} of {goal} orders
        </p>
      </div>

      <div className="relative mt-3">
        <div className="bg-surface-2 h-1.5 w-full rounded-full">
          <div
            className="bg-brand-500 h-1.5 rounded-full"
            style={{ width: `${percent}%` }}
            role="progressbar"
            aria-valuenow={Math.min(done, goal)}
            aria-valuemin={0}
            aria-valuemax={goal}
            aria-label={`${done} of ${goal} completed orders`}
          />
        </div>

        {/* The marks. Positioned along the same track rather than listed
            underneath, so the bar carries the whole story in one glance. */}
        {marks.map((mark) => (
          <span
            key={mark}
            aria-hidden
            title={`${mark} orders`}
            className={`absolute -top-0.5 size-2.5 -translate-x-1/2 rounded-full ring-2 ring-white ${
              reached.has(mark) ? 'bg-brand-700' : 'bg-surface-3'
            }`}
            style={{ left: `${Math.min(100, (mark / goal) * 100)}%` }}
          />
        ))}
      </div>

      <p className="text-muted mt-3 text-xs leading-relaxed">
        {progress.reward_unlocked
          ? `You have completed ${done} orders. The Campus Dash team will be in touch about your reward.`
          : messageFor(done, goal, progress.next_milestone, progress.orders_to_next)}
      </p>
    </section>
  );
}

/**
 * One sentence, and which one depends on how close somebody is.
 *
 * A milestone just passed is worth a word; being a long way off is not, so that
 * case says the plain fact and nothing else.
 */
function messageFor(done, goal, next, toNext) {
  const remaining = Number(toNext ?? 0);
  const mark = Number(next ?? 0);

  if (mark === goal) {
    return `${remaining} more ${remaining === 1 ? 'order' : 'orders'} to reach ${goal}.`;
  }
  if (mark > 0) {
    return `${remaining} more ${remaining === 1 ? 'order' : 'orders'} to the next mark at ${mark}. The goal is ${goal}.`;
  }
  return `${done} completed orders so far.`;
}
