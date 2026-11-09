import Link from 'next/link';
import { requireRole } from '@/lib/require-role';
import { apiGet } from '@/lib/api';
import { PageHeader } from '@/components/layout/page-header';
import { Card } from '@/components/ui/card';
import { ApiErrorState } from '@/components/states/api-error';
import { sessionTime } from '@/lib/booking-format';
import { sessionLabels } from '@/lib/wallet';
import type { MentorSession, Weekly, Blockout } from '@/lib/dashboard';
export const metadata = { title: 'Mentor dashboard' };
export default async function MentorHome() {
  const user = await requireRole('mentor');
  try {
    const [{ items }, weekly, blocks] = await Promise.all([
      apiGet<{ items: MentorSession[] }>('/mentor/sessions?status=upcoming'),
      apiGet<Weekly[]>('/mentor/availability'),
      apiGet<Blockout[]>('/mentor/blockouts'),
    ]);
    const next = items.find((s) => Date.parse(s.endsAt) > Date.now());
    return (
      <>
        <PageHeader title="Mentor dashboard" description={user.displayName + ' · ' + user.timezone} />
        <div className="grid gap-4 md:grid-cols-2">
          <Card className="space-y-3 border-t-4 border-t-primary p-6">
            <h2 className="text-lg font-semibold">Next session</h2>
            {next ? (
              <>
                <p className="text-2xl font-semibold">{next.mentee.displayName}</p>
                <p>
                  {sessionTime(next.startsAt, next.endsAt, user.timezone)} · {sessionLabels[next.status]}
                </p>
              </>
            ) : (
              <p>No upcoming session</p>
            )}
            <Link className="inline-block text-primary underline" href="/mentor/sessions">
              View sessions ({items.length})
            </Link>
          </Card>
          <Card className="space-y-3 p-6">
            <h2 className="text-lg font-semibold">Schedule</h2>
            <p>{weekly.filter((w) => w.isActive).length} active weekly windows</p>
            <p>{blocks.filter((b) => Date.parse(b.endsAt) > Date.now()).length} upcoming blockouts</p>
            <Link className="text-primary underline" href="/mentor/availability">
              Manage availability
            </Link>
          </Card>
        </div>
      </>
    );
  } catch (e) {
    return <ApiErrorState error={e} />;
  }
}
