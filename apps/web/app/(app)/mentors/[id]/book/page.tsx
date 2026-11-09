import { notFound, redirect } from 'next/navigation';
import { PageHeader } from '@/components/layout/page-header';
import { BookingCalendar } from '@/components/booking/booking-calendar';
import { ApiErrorState } from '@/components/states/api-error';
import { ApiError, apiGet, bookingAccountScope } from '@/lib/api';
import { currentUser, homeFor } from '@/lib/session';
import { addDays, zoneDate } from '@/lib/format';
import { dateParam } from '@/lib/booking-format';
import type { MentorProfile, SlotPreview } from '@/lib/types';

export const metadata = { title: 'Book a session' };
export default async function BookingPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ week?: string }>;
}) {
  const user = await currentUser();
  if (!user) redirect('/?error=signin-required');
  if (user.role !== 'mentee') redirect(homeFor(user.role));
  const { id } = await params;
  const today = zoneDate(user.timezone, new Date());
  const week = dateParam((await searchParams).week, today);
  // A viewer date can differ from the mentor's by up to two calendar days across the date line.
  const query = new URLSearchParams({
    from: addDays(week, -2),
    to: addDays(week, 8),
    timezone: user.timezone,
  });
  let data;
  try {
    const path = '/mentors/' + encodeURIComponent(id);
    data = await Promise.all([
      apiGet<MentorProfile>(path),
      apiGet<SlotPreview>(path + '/slots?' + query),
      apiGet<{ totalSpendable: number }>('/wallet/me'),
    ]);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    return <ApiErrorState error={error} />;
  }
  const [mentor, preview, wallet] = data;
  const days = Array.from({ length: 7 }, (_, i) => addDays(week, i));
  return (
    <>
      <PageHeader
        title="Book a session"
        breadcrumbs={[
          { label: 'Mentors', href: '/mentors' },
          { label: mentor.displayName, href: '/mentors/' + id },
          { label: 'Book a session' },
        ]}
      />
      <BookingCalendar
        key={bookingAccountScope(user.id) + id + week}
        account={bookingAccountScope(user.id)}
        mentor={mentor}
        zone={preview.viewerTimezone}
        days={days}
        today={today}
        credits={wallet.totalSpendable}
        slots={preview.slots.filter((s) => days.includes(s.localStartsAt.slice(0, 10)))}
      />
    </>
  );
}
