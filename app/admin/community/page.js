import { customerRewards, partnerRatings } from '@/lib/admin';
import { Panel, Empty, Unavailable, Table, Row, Cell, when } from '../ui';
import SettleRewardForm from './settle-reward-form';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Community · Campus Dash' };

/**
 * The two things students do to each other on Campus Dash: reach the order goal
 * and rate a Partner.
 *
 * ONE PAGE, because both are the same operational question — who needs somebody
 * at Campus Dash to do something about them. An unlocked reward needs a
 * decision about what the reward is. A one-star rating needs a conversation.
 * Neither is a dashboard metric.
 *
 * NULL MEANS THE QUESTION FAILED, [] MEANS THE ANSWER IS NONE. An empty ratings
 * table and a failed query look identical, and reading the second as the first
 * concludes that nobody is unhappy.
 */
export default async function AdminCommunityPage() {
  const [rewards, lowRatings, recentRatings] = await Promise.all([
    customerRewards({ status: 'UNLOCKED', limit: 100 }).catch(() => null),
    partnerRatings({ maxStars: 2, limit: 50 }).catch(() => null),
    partnerRatings({ limit: 50 }).catch(() => null),
  ]);

  return (
    <>
      <h1 className="mb-2 text-2xl font-semibold tracking-tight">Community</h1>
      <p className="text-muted mb-6 max-w-3xl text-sm leading-relaxed">
        Customers who have reached the order goal, and how Partners are being rated. The reward
        itself is not defined anywhere in the software: reaching the goal records that somebody
        qualified, and what they are given is Campus Dash&apos;s decision.
      </p>

      <Panel
        title="Rewards to settle"
        description="Customers who reached the goal and have not been given anything yet."
      >
        {rewards === null ? (
          <Unavailable>Rewards could not be loaded.</Unavailable>
        ) : rewards.length === 0 ? (
          <Empty>Nobody is waiting on a reward.</Empty>
        ) : (
          <div className="space-y-4">
            {rewards.map((reward) => (
              <div key={reward.reward_id} className="border-line rounded-card border p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <p className="font-semibold">{reward.customer_name ?? 'Unnamed'}</p>
                  <p className="text-muted text-xs tabular-nums">
                    {reward.completed_orders} completed &middot; reached{' '}
                    {reward.cycle * reward.goal_orders} on {when(reward.unlocked_at)}
                  </p>
                </div>
                <p className="text-muted mt-0.5 text-sm">
                  {reward.email ?? reward.phone ?? reward.user_id}
                </p>
                <SettleRewardForm rewardId={reward.reward_id} name={reward.customer_name} />
              </div>
            ))}
          </div>
        )}
      </Panel>

      <Panel
        title="Ratings needing attention"
        description="One and two stars. A rating is one person's account of one order, so read the comment before acting on the number."
      >
        <RatingTable rows={lowRatings} emptyText="No low ratings." />
      </Panel>

      <Panel title="Recent ratings" description="Most recent fifty, all scores.">
        <RatingTable rows={recentRatings} emptyText="No ratings yet." />
      </Panel>
    </>
  );
}

function RatingTable({ rows, emptyText }) {
  if (rows === null) return <Unavailable>Ratings could not be loaded.</Unavailable>;
  if (rows.length === 0) return <Empty>{emptyText}</Empty>;

  return (
    <Table head={['Partner', 'Stars', 'Comment', 'Order', 'Customer', 'When']} minWidth="52rem">
      {rows.map((rating) => (
        <Row key={rating.order_id}>
          <Cell>{rating.partner_name ?? '-'}</Cell>
          <Cell numeric>{'★'.repeat(rating.stars)}</Cell>
          <Cell muted>{rating.comment ?? '-'}</Cell>
          <Cell mono>{rating.order_number}</Cell>
          <Cell muted>{rating.customer_name ?? '-'}</Cell>
          <Cell muted>{when(rating.created_at)}</Cell>
        </Row>
      ))}
    </Table>
  );
}
