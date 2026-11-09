'use client';

import { Loader2, Search, X } from 'lucide-react';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { Input, Label, NativeSelect } from '@/components/ui/input';
import { directoryQueryString, zoneCity, type DirectoryFilters } from '@/lib/format';

// Search and filters live in the URL (shareable, back/forward friendly). Typing is debounced; the
// server re-renders the results for the new URL inside a transition, so the page never reloads.
export function DirectoryControls({ filters, timezones }: { filters: DirectoryFilters; timezones: { timezone: string; count: number }[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();
  const [q, setQ] = useState(filters.q);
  const latest = useRef(filters);
  // Resync the input only for external URL changes (back/forward), never over text being typed.
  useEffect(() => {
    if (filters.q !== latest.current.q) setQ(filters.q);
    latest.current = filters;
  }, [filters]);

  const apply = (next: Partial<DirectoryFilters>) => {
    const merged = { ...latest.current, ...next };
    latest.current = merged;
    startTransition(() => router.replace(pathname + directoryQueryString(merged), { scroll: false }));
  };

  useEffect(() => {
    if (q.trim() === latest.current.q) return;
    const timer = setTimeout(() => apply({ q: q.trim() }), 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const active = Boolean(filters.q || filters.timezone);
  return (
    <form role="search" aria-label="Find mentors" onSubmit={event => { event.preventDefault(); apply({ q: q.trim() }); }}
      className="grid gap-3 rounded-xl border border-border bg-card p-4 shadow-card sm:grid-cols-[1fr_15rem_auto] sm:items-end">
      <div className="grid gap-1.5">
        <Label htmlFor="mentor-search">Search</Label>
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input id="mentor-search" type="search" value={q} onChange={event => setQ(event.target.value)} maxLength={100}
            placeholder="Name or keyword, e.g. React" autoComplete="off" className="pl-9 pr-9" />
          {pending && <Loader2 className="absolute right-3 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted-foreground" aria-hidden />}
        </div>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="mentor-timezone">Timezone</Label>
        <NativeSelect id="mentor-timezone" value={filters.timezone} onChange={event => apply({ timezone: event.target.value })}>
          <option value="">All timezones</option>
          {timezones.map(zone => (
            <option key={zone.timezone} value={zone.timezone}>{zoneCity(zone.timezone)} ({zone.timezone}) · {zone.count}</option>
          ))}
        </NativeSelect>
      </div>
      <Button type="button" variant="ghost" disabled={!active && !q} onClick={() => { setQ(''); apply({ q: '', timezone: '' }); }}
        className="text-muted-foreground sm:mb-0">
        <X aria-hidden />Clear filters
      </Button>
      <p className="sr-only" role="status" aria-live="polite">{pending ? 'Updating results…' : ''}</p>
    </form>
  );
}
