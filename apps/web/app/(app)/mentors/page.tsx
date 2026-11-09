import { SearchX, UsersRound, X } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { PageHeader } from '@/components/layout/page-header';
import { DirectoryControls } from '@/components/mentors/directory-controls';
import { MentorCard } from '@/components/mentors/mentor-card';
import { ApiErrorState } from '@/components/states/api-error';
import { EmptyState } from '@/components/states/empty-state';
import { Button } from '@/components/ui/button';
import { apiGet } from '@/lib/api';
import { directoryFilters, directoryQueryString, directoryView, resultSummary, zoneCity } from '@/lib/format';
import type { DirectoryResponse } from '@/lib/types';

export const metadata: Metadata = { title: 'Find your mentor' };

const header = <PageHeader title="Find your mentor" description="Discover experienced mentors and find the right guidance for your goals." />;

export default async function MentorDirectory({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const filters = directoryFilters(await searchParams);
  let data: DirectoryResponse;
  try {
    // Search and filtering run in PostgreSQL over the whole directory, never over a client subset.
    data = await apiGet<DirectoryResponse>('/mentors' + directoryQueryString(filters));
  } catch (error) {
    return <>{header}<ApiErrorState error={error} forbidden={{
      title: 'The mentor directory is for mentee accounts',
      description: 'Switch to a mentee demo account to browse and book mentors.',
      action: <Button asChild variant="outline"><Link href="/?switch=1">Switch account</Link></Button>,
    }} /></>;
  }
  const view = directoryView(data.total, filters);
  const now = new Date();
  const chips = [
    filters.q && { label: `“${filters.q}”`, clear: { ...filters, q: '' }, name: 'search' },
    filters.timezone && { label: zoneCity(filters.timezone), clear: { ...filters, timezone: '' }, name: 'timezone filter' },
  ].filter(Boolean) as { label: string; clear: typeof filters; name: string }[];

  return (
    <>
      {header}
      <DirectoryControls filters={filters} timezones={data.facets.timezones} />
      <div className="mt-6 flex min-h-8 flex-wrap items-center gap-2">
        <p className="text-sm font-medium" role="status" aria-live="polite" data-testid="result-count">{resultSummary(data.total, filters)}</p>
        {chips.map(chip => (
          <Link key={chip.name} href={'/mentors' + directoryQueryString(chip.clear)} scroll={false}
            className="inline-flex items-center gap-1 rounded-full border border-border bg-card px-2.5 py-1 text-xs font-medium hover:bg-accent">
            {chip.label}<X className="size-3" aria-hidden /><span className="sr-only">Remove {chip.name}</span>
          </Link>
        ))}
      </div>
      <section aria-label="Mentors" className="mt-4">
        {view === 'results' && (
          <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {data.items.map(mentor => <li key={mentor.id}><MentorCard mentor={mentor} now={now} /></li>)}
          </ul>
        )}
        {view === 'no-results' && (
          <EmptyState icon={SearchX} title="No mentors match your search."
            description="Try a different keyword or timezone, or clear the filters to see everyone."
            action={<Button asChild variant="outline"><Link href="/mentors" scroll={false}>Clear filters</Link></Button>} />
        )}
        {view === 'empty' && (
          <EmptyState icon={UsersRound} title="No mentors yet"
            description="Mentors will appear here as soon as they join. Please check back later." />
        )}
      </section>
    </>
  );
}
