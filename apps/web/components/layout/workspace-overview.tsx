import { Clock } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { NAVIGATION } from '@/lib/navigation';
import type { CurrentUser } from '@/lib/types';
import { NavIcon } from './nav-icon';
import { PageHeader } from './page-header';

// Landing page for roles whose screens arrive in later stories. It states plainly what is coming
// rather than showing placeholder data.
export function WorkspaceOverview({ user, title, description }: { user: CurrentUser; title: string; description: string }) {
  const upcoming = NAVIGATION[user.role].filter(item => item.status === 'upcoming');
  return (
    <>
      <PageHeader title={title} description={description} />
      <Card className="p-5 sm:p-6">
        <h2 className="flex items-center gap-2 text-base font-semibold"><Clock className="size-4 text-primary" aria-hidden />Coming next</h2>
        <p className="mt-1 text-sm text-muted-foreground">These screens are planned and appear in the navigation as “Soon”.</p>
        <ul className="mt-5 grid gap-3 sm:grid-cols-2">
          {upcoming.map(item => (
            <li key={item.href} className="flex items-center gap-3 rounded-lg border border-border p-3.5">
              <span className="flex size-9 items-center justify-center rounded-lg bg-primary-soft text-primary-soft-foreground"><NavIcon name={item.icon} className="size-4" /></span>
              <span className="flex-1 text-sm font-medium">{item.label}</span>
              <Badge variant="neutral">Soon</Badge>
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}
