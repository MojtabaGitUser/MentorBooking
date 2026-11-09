import { Activity, ArrowRight, GraduationCap, ShieldCheck, UserRound } from 'lucide-react';
import { redirect } from 'next/navigation';
import type { HealthReport } from '@mentor/shared';
import { signIn } from './actions';
import { ThemeToggle } from '@/components/layout/theme-toggle';
import { InitialsAvatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { apiBaseUrl, apiGet } from '@/lib/api';
import { zoneCity } from '@/lib/format';
import { ROLE_LABEL } from '@/lib/navigation';
import { currentUser, DEMO_ACCOUNT_IDS, homeFor } from '@/lib/session';
import type { CurrentUser, Role } from '@/lib/types';

export const dynamic = 'force-dynamic';

async function readHealth(): Promise<HealthReport | undefined> {
  try {
    const response = await fetch(new URL('/health', apiBaseUrl()), { cache: 'no-store', signal: AbortSignal.timeout(3500) });
    if (response.ok || response.status === 503) return await response.json();
  } catch {
    // Keep the page reachable while the API is starting.
  }
}

async function demoAccounts(): Promise<CurrentUser[]> {
  const results = await Promise.allSettled(DEMO_ACCOUNT_IDS.map(id => apiGet<CurrentUser>('/me', { userId: id })));
  return results.flatMap(result => (result.status === 'fulfilled' ? [result.value] : []));
}

const ERRORS: Record<string, string> = {
  'unknown-account': 'That demo account is not available. Run the seed command and try again.',
  unavailable: 'The booking service could not be reached. Please try again in a moment.',
  'signin-required': 'Please choose a demo account to continue.',
};
const ROLE_ORDER: Role[] = ['mentee', 'mentor', 'admin'];
const ROLE_HINT: Record<Role, string> = {
  mentee: 'Browse mentors and book sessions',
  mentor: 'Manage availability and sessions',
  admin: 'Inspect ledgers and adjust credits',
};

export default async function Landing({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const params = await searchParams;
  const user = await currentUser().catch(() => null);
  if (user && !params.switch) redirect(homeFor(user.role));
  const [health, accounts] = await Promise.all([readHealth(), demoAccounts()]);
  const error = params.error && ERRORS[params.error];

  return (
    <div className="relative min-h-dvh bg-[radial-gradient(60rem_30rem_at_50%_-10%,var(--color-primary-soft),transparent)]">
      <div className="absolute right-4 top-4"><ThemeToggle /></div>
      <main className="mx-auto flex max-w-5xl flex-col px-4 py-12 sm:px-6 sm:py-16">
        <div className="flex items-center gap-3">
          <span className="flex size-11 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-raised">
            <GraduationCap className="size-6" aria-hidden />
          </span>
          <h1 className="text-3xl font-semibold tracking-tight">Mentor Booking</h1>
        </div>
        <p className="mt-3 max-w-xl text-base text-muted-foreground">
          Book focused 30-minute sessions with mentors across timezones, paid with credits.
        </p>

        <div className="mt-10 grid gap-6 lg:grid-cols-[1fr_20rem]">
          <section aria-labelledby="accounts-heading">
            <h2 id="accounts-heading" className="text-lg font-semibold">Choose a demo account</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              This demo uses seeded accounts instead of passwords. The API checks every request against the chosen account&apos;s role.
            </p>
            {error && <p role="alert" className="mt-4 rounded-lg border border-warning/30 bg-warning-soft px-4 py-3 text-sm text-warning">{error}</p>}
            {accounts.length === 0 ? (
              <Card className="mt-4 p-5 text-sm text-muted-foreground" role="status">
                No demo accounts are available. Make sure the API is running with <code className="font-mono">DEMO_AUTH_ENABLED=true</code> and the seed command has been run.
              </Card>
            ) : ROLE_ORDER.map(role => {
              const group = accounts.filter(account => account.role === role);
              if (!group.length) return null;
              return (
                <div key={role} className="mt-6">
                  <h3 className="flex items-center gap-2 text-sm font-medium">
                    {ROLE_LABEL[role]}s <span className="font-normal text-muted-foreground">· {ROLE_HINT[role]}</span>
                  </h3>
                  <ul className="mt-2 grid gap-2 sm:grid-cols-2">
                    {group.map(account => (
                      <li key={account.id}>
                        <form action={signIn}>
                          <input type="hidden" name="userId" value={account.id} />
                          <button type="submit" className="group flex w-full items-center gap-3 rounded-xl border border-border bg-card p-3 text-left shadow-card transition hover:border-primary/40 hover:shadow-raised">
                            <InitialsAvatar name={account.displayName} seed={account.id} className="size-10 text-sm" />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm font-medium">{account.displayName}</span>
                              <span className="block truncate text-xs text-muted-foreground">{ROLE_LABEL[account.role]} · {zoneCity(account.timezone)}</span>
                            </span>
                            <ArrowRight className="size-4 text-muted-foreground transition group-hover:translate-x-0.5 group-hover:text-primary" aria-hidden />
                            <span className="sr-only">Continue as {account.displayName}</span>
                          </button>
                        </form>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </section>

          <aside className="space-y-4">
            <Card className="p-5">
              <h2 className="flex items-center gap-2 text-sm font-semibold"><Activity className="size-4 text-primary" aria-hidden />Service status</h2>
              <dl className="mt-4 grid grid-cols-[1fr_auto] gap-y-3 text-sm">
                <dt className="text-muted-foreground">API</dt>
                <dd><Badge variant={health ? 'success' : 'destructive'}>{health ? 'Reachable' : 'Unavailable'}</Badge></dd>
                <dt className="text-muted-foreground">PostgreSQL</dt>
                <dd><Badge variant={health?.database === 'up' ? 'success' : health ? 'destructive' : 'neutral'}>
                  {health ? (health.database === 'up' ? 'Connected' : 'Disconnected') : 'Unknown'}</Badge></dd>
              </dl>
            </Card>
            <Card className="p-5 text-sm text-muted-foreground">
              <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground"><ShieldCheck className="size-4 text-primary" aria-hidden />About demo sign-in</h2>
              <p className="mt-2">Your choice is kept in a cookie that page scripts cannot read. Navigation adapts to the role, but the API enforces every permission.</p>
              {user && <p className="mt-3 flex items-center gap-2 text-foreground"><UserRound className="size-4" aria-hidden />Signed in as {user.displayName}</p>}
            </Card>
          </aside>
        </div>
      </main>
    </div>
  );
}
