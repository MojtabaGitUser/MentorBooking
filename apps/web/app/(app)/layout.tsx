import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { AppShell } from '@/components/layout/app-shell';
import { ApiErrorState } from '@/components/states/api-error';
import { currentUser } from '@/lib/session';

export const dynamic = 'force-dynamic';

// Every signed-in page shares the shell. No valid demo identity means back to account selection;
// an unreachable API is shown as an error, not as "signed out".
export default async function AppLayout({ children }: { children: ReactNode }) {
  let user;
  try {
    user = await currentUser();
  } catch (error) {
    return <main className="mx-auto max-w-xl px-4 py-16"><ApiErrorState error={error} /></main>;
  }
  if (!user) redirect('/?error=signin-required');
  return <AppShell user={user}>{children}</AppShell>;
}
