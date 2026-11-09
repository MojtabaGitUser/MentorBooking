import Link from 'next/link';
import { requireRole } from '@/lib/require-role';
import { apiGet, bookingAccountScope } from '@/lib/api';
import { PageHeader } from '@/components/layout/page-header';
import { ApiErrorState } from '@/components/states/api-error';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Ledger } from '@/components/wallet/ledger';
import { AdjustmentForm } from './adjustment';
import type { DirectoryUser, Audit } from '@/lib/dashboard';
export type Search = Promise<{ q?: string; user?: string; cursor?: string }>;
export async function AdminConsole({
  searchParams,
  path,
  title,
}: {
  searchParams: Search;
  path: string;
  title: string;
}) {
  const admin = await requireRole('admin'),
    params = await searchParams;
  const q = typeof params.q === 'string' ? params.q : '',
    id = typeof params.user === 'string' ? params.user : '';
  const link = (target: string, cursor?: string) =>
    path + '?' + new URLSearchParams({ user: target, ...(q && { q }), ...(cursor && { cursor }) });
  try {
    const [users, audit] = await Promise.all([
      apiGet<{ items: DirectoryUser[]; hasMore: boolean }>('/admin/users?q=' + encodeURIComponent(q)),
      id
        ? apiGet<Audit>(
            '/admin/users/' +
              encodeURIComponent(id) +
              '/ledger?limit=20' +
              (params.cursor ? '&cursor=' + encodeURIComponent(params.cursor) : ''),
          )
        : null,
    ]);
    return (
      <>
        <PageHeader
          title={title}
          description="Look up a user to inspect their ledger or adjust mentee credits."
        />
        <div className="grid items-start gap-5 lg:grid-cols-[minmax(15rem,1fr)_minmax(0,2fr)]">
          <Card className="min-w-0 p-5">
            <h2 className="text-lg font-semibold">User lookup</h2>
            <form action={path} className="my-4 space-y-2">
              <label className="block text-sm">
                Name or user ID
                <input
                  className="mt-1 w-full rounded-md border border-border bg-background p-2"
                  name="q"
                  defaultValue={q}
                />
              </label>
              <Button size="sm">Search users</Button>
            </form>
            <ul className="max-h-80 overflow-y-auto divide-y divide-border lg:max-h-[32rem]">
              {users.items.map((u) => (
                <li key={u.id}>
                  <Link
                    className="block rounded px-2 py-2 hover:bg-accent aria-current:bg-secondary"
                    aria-current={u.id === id ? 'true' : undefined}
                    href={link(u.id) + '#selected-user'}
                  >
                    <span className="font-medium">{u.displayName}</span>
                    <span className="ml-2 text-sm text-muted-foreground">{u.role}</span>
                    <span className="block break-all text-xs text-muted-foreground">{u.id}</span>
                  </Link>
                </li>
              ))}
            </ul>
            {users.hasMore && <p className="text-sm">Showing 25 matches. Refine your search.</p>}
            {!users.items.length && <p>No matching users.</p>}
          </Card>
          {audit ? (
            <div id="selected-user" className="min-w-0 scroll-mt-20 space-y-5">
              <Card className="space-y-2 p-5">
                <h2 className="text-xl font-semibold">{audit.user.displayName}</h2>
                <p className="text-sm capitalize">{audit.user.role}</p>
                {audit.balance ? (
                  <>
                    <p className="text-2xl font-semibold">
                      {audit.balance.totalSpendable} spendable{' '}
                      {audit.balance.totalSpendable === 1 ? 'credit' : 'credits'}
                    </p>
                    <p className="text-sm">
                      Normal {audit.balance.normal} · Rollover {audit.balance.rollover} · Debt{' '}
                      {audit.balance.debt}
                    </p>
                  </>
                ) : (
                  <p>Only mentees hold credits.</p>
                )}
              </Card>
              {audit.user.role === 'mentee' && !params.cursor && (
                <AdjustmentForm
                  key={admin.id + id}
                  account={bookingAccountScope(admin.id)}
                  target={id}
                  name={audit.user.displayName}
                  zone={admin.timezone}
                />
              )}
              <Card className="p-5">
                <h2 className="text-lg font-semibold">Credit ledger</h2>
                <p className="text-sm text-muted-foreground">{admin.timezone}</p>
                <Ledger rows={audit.items} zone={admin.timezone} />
                <nav aria-label="Ledger pages" className="flex gap-4 text-primary underline">
                  {params.cursor && <Link href={link(id)}>Latest transactions</Link>}
                  {audit.nextCursor && <Link href={link(id, audit.nextCursor)}>Older transactions</Link>}
                </nav>
              </Card>
            </div>
          ) : (
            <Card className="p-6">
              <h2 className="font-semibold">Select a user</h2>
              <p className="mt-2 text-sm text-muted-foreground">
                Their credit balance and ledger will appear here.
              </p>
            </Card>
          )}
        </div>
      </>
    );
  } catch (error) {
    return (
      <>
        <Link className="text-primary underline" href={path}>
          Back to user lookup
        </Link>
        <ApiErrorState error={error} />
      </>
    );
  }
}
