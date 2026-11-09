import { ArrowRight, CalendarDays, Globe } from 'lucide-react';
import Link from 'next/link';
import { InitialsAvatar } from '@/components/ui/avatar';
import { Card } from '@/components/ui/card';
import { localTime, weekdaysSummary, zoneCity, zoneOffset } from '@/lib/format';
import type { MentorSummary } from '@/lib/types';

// Shows only what the API provides: name, timezone, bio and the weekdays with weekly hours.
export function MentorCard({ mentor, now }: { mentor: MentorSummary; now: Date }) {
  const days = weekdaysSummary(mentor.availableWeekdays);
  const titleId = `mentor-${mentor.id}`;
  return (
    <Card className="group relative flex h-full flex-col p-5 transition-shadow hover:shadow-raised focus-within:shadow-raised" data-testid="mentor-card">
      <article aria-labelledby={titleId} className="flex h-full flex-col">
        <div className="flex items-start gap-3.5">
          <InitialsAvatar name={mentor.displayName} seed={mentor.id} className="size-12 text-base" />
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="truncate text-base font-semibold leading-tight">{mentor.displayName}</h2>
            <p className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground" title={mentor.timezone}>
              <Globe className="size-3.5 shrink-0" aria-hidden />
              <span className="truncate">{zoneCity(mentor.timezone)} · {zoneOffset(mentor.timezone, now)}</span>
            </p>
          </div>
        </div>
        {/* The clamp sits on the inner paragraph; the wrapper takes the spare height so footers align. */}
        <div className="mt-4 flex-1">
          <p className="line-clamp-3 text-sm leading-relaxed text-muted-foreground">
            {mentor.bio || <span className="italic">This mentor hasn&apos;t added an introduction yet.</span>}
          </p>
        </div>
        <div className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
          <CalendarDays className="size-3.5 shrink-0" aria-hidden />
          {days ? <span><span className="sr-only">Weekly hours on </span>{days}</span> : <span>No weekly hours yet</span>}
          <span className="ml-auto whitespace-nowrap" aria-label={`Local time for ${mentor.displayName}: ${localTime(mentor.timezone, now)}`}>
            {localTime(mentor.timezone, now)} local
          </span>
        </div>
        <div className="mt-4 border-t border-border pt-4">
          <Link href={`/mentors/${mentor.id}`} className="inline-flex items-center gap-1.5 rounded-md text-sm font-medium text-primary after:absolute after:inset-0 after:rounded-xl hover:text-primary-hover">
            View profile<span className="sr-only"> of {mentor.displayName}</span>
            <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" aria-hidden />
          </Link>
        </div>
      </article>
    </Card>
  );
}
