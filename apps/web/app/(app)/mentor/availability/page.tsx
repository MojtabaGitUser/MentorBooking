import { requireRole } from '@/lib/require-role';
import { apiGet, bookingAccountScope } from '@/lib/api';
import { ApiErrorState } from '@/components/states/api-error';
import { PageHeader } from '@/components/layout/page-header';
import { localStamp, type Weekly, type Blockout } from '@/lib/dashboard';
import { Schedule } from '@/components/dashboard/schedule';
export default async function Availability() {
  const user = await requireRole('mentor');
  try {
    const [weekly, blocks] = await Promise.all([
      apiGet<Weekly[]>('/mentor/availability'),
      apiGet<Blockout[]>('/mentor/blockouts'),
    ]);
    return (
      <>
        <PageHeader
          title="Availability"
          description={user.timezone}
          breadcrumbs={[{ label: 'Dashboard', href: '/mentor' }, { label: 'Availability' }]}
        />
        <Schedule
          weekly={weekly}
          blocks={blocks.filter((b) => Date.parse(b.endsAt) > Date.now())}
          zone={user.timezone}
          account={bookingAccountScope(user.id)}
          example={localStamp(new Date().toISOString().slice(0, 16) + ':00Z', user.timezone)}
        />
      </>
    );
  } catch (e) {
    return <ApiErrorState error={e} />;
  }
}
