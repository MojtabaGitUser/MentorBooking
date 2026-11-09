import { CalendarClock, CalendarDays, Clock, Globe, Info } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Breadcrumbs, PageHeader } from '@/components/layout/page-header';
import { ApiErrorState } from '@/components/states/api-error';
import { InitialsAvatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiError, apiGet } from '@/lib/api';
import { addDays, localTime, weekdayLong, zoneCity, zoneDate, zoneOffset } from '@/lib/format';
import type { MentorProfile, SlotPreview } from '@/lib/types';

type Params = { params: Promise<{ id: string }> };

async function loadProfile(id: string) {
  try {
    return { profile: await apiGet<MentorProfile>(`/mentors/${encodeURIComponent(id)}`) };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    return { error };
  }
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { profile } = await loadProfile((await params).id);
  return { title: profile ? profile.displayName : 'Mentor' };
}

// Next openings from the existing slot preview API (mentor's calendar, next 14 days), shown in the
// viewer's timezone. A preview only: booking re-checks everything (US-11) and ships in US-16.
async function upcomingOpenings(profile: MentorProfile) {
  const from = zoneDate(profile.timezone, new Date());
  try {
    const preview = await apiGet<SlotPreview>(`/mentors/${profile.id}/slots?from=${from}&to=${addDays(from, 13)}`);
    return { preview };
  } catch (error) {
    return { error: error instanceof ApiError ? error.code : 'UNKNOWN' };
  }
}

export default async function MentorProfilePage({ params }: Params) {
  const { profile, error } = await loadProfile((await params).id);
  const crumbs = [{ label: 'Mentors', href: '/mentors' }, { label: profile?.displayName ?? 'Mentor' }];
  if (!profile) {
    return <><PageHeader title="Mentor profile" breadcrumbs={crumbs} /><ApiErrorState error={error} forbidden={{
      title: 'Mentor profiles are for mentee accounts', description: 'Switch to a mentee demo account to view mentor profiles.',
      action: <Button asChild variant="outline"><Link href="/?switch=1">Switch account</Link></Button>,
    }} /></>;
  }
  const now = new Date();
  const openings = await upcomingOpenings(profile);
  const firstName = profile.displayName.split(' ')[0];

  return (
    <>
      <Breadcrumbs items={crumbs} className="mb-4" />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-6">
          <Card className="p-5 sm:p-6">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
              <InitialsAvatar name={profile.displayName} seed={profile.id} className="size-16 text-xl" />
              <div className="min-w-0">
                <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">{profile.displayName}</h1>
                <p className="mt-0.5 text-sm text-muted-foreground">Mentor · 30-minute sessions</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Badge variant="neutral" title={profile.timezone}><Globe aria-hidden />{profile.timezone} · {zoneOffset(profile.timezone, now)}</Badge>
                  <Badge variant="neutral"><Clock aria-hidden />{localTime(profile.timezone, now)} local time</Badge>
                </div>
              </div>
            </div>
          </Card>

          <Card>
            <CardHeader><CardTitle>About</CardTitle></CardHeader>
            <CardContent>
              {/* Rendered as text: React escapes it, so profile content can never inject markup. */}
              <p className="whitespace-pre-line text-sm leading-relaxed text-muted-foreground" data-testid="mentor-bio">
                {profile.bio || `${firstName} hasn't added an introduction yet.`}
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><CalendarDays className="size-4 text-primary" aria-hidden />Weekly hours</CardTitle>
              <CardDescription>Recurring hours in {firstName}&apos;s timezone ({profile.timezone}).</CardDescription>
            </CardHeader>
            <CardContent>
              {profile.weeklyAvailability.length ? (
                <table className="w-full text-sm">
                  <caption className="sr-only">Weekly hours in {profile.timezone}</caption>
                  <thead className="sr-only"><tr><th scope="col">Day</th><th scope="col">Hours</th></tr></thead>
                  <tbody className="divide-y divide-border">
                    {[...new Set(profile.weeklyAvailability.map(rule => rule.weekday))].map(weekday => (
                      <tr key={weekday}>
                        <th scope="row" className="py-2.5 pr-4 text-left font-medium">{weekdayLong(weekday)}</th>
                        <td className="py-2.5 text-right tabular-nums text-muted-foreground">
                          {profile.weeklyAvailability.filter(rule => rule.weekday === weekday)
                            .map(rule => `${rule.startLocal}–${rule.endLocal}`).join(', ')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : <p className="text-sm text-muted-foreground">{firstName} hasn&apos;t published weekly hours yet.</p>}
            </CardContent>
          </Card>
        </div>

        <aside className="lg:sticky lg:top-24 lg:self-start" aria-labelledby="booking-heading">
          <Card data-testid="booking-panel">
            <CardHeader>
              <CardTitle id="booking-heading" className="flex items-center gap-2"><CalendarClock className="size-4 text-primary" aria-hidden />Upcoming openings</CardTitle>
              <CardDescription>
                {openings.preview ? <>Next 30-minute slots, shown in your timezone ({zoneCity(openings.preview.viewerTimezone)}).</> : 'Next 30-minute slots.'}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {openings.preview ? (
                openings.preview.slots.length ? (
                  <ul className="grid gap-2" data-testid="openings">
                    {openings.preview.slots.slice(0, 6).map(slot => {
                      const start = new Date(slot.startsAt);
                      const zone = openings.preview.viewerTimezone;
                      return (
                        <li key={slot.startsAt} className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-sm">
                          <span className="font-medium">{new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'short', month: 'short', day: 'numeric' }).format(start)}</span>
                          <time dateTime={slot.startsAt} className="tabular-nums text-muted-foreground">{localTime(zone, start)}</time>
                        </li>
                      );
                    })}
                  </ul>
                ) : <p className="text-sm text-muted-foreground">No open slots in the next two weeks.</p>
              ) : <p role="alert" className="text-sm text-destructive">Openings could not be loaded right now ({openings.error}).</p>}
              <Button className="mt-5 w-full" disabled aria-describedby="booking-note">Book a session</Button>
              <p id="booking-note" className="mt-2 flex items-start gap-1.5 text-xs text-muted-foreground">
                <Info className="mt-px size-3.5 shrink-0" aria-hidden />Online booking is coming in the next release. Each session costs one credit.
              </p>
            </CardContent>
          </Card>
        </aside>
      </div>
    </>
  );
}
