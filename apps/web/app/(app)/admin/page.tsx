import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { WorkspaceOverview } from '@/components/layout/workspace-overview';
import { currentUser, homeFor } from '@/lib/session';

export const metadata: Metadata = { title: 'Admin dashboard' };

export default async function AdminHome() {
  const user = (await currentUser())!;
  if (user.role !== 'admin') redirect(homeFor(user.role));
  return <WorkspaceOverview user={user} title="Admin dashboard"
    description="Operations workspace. User lookup, ledger audit and credit adjustments arrive in the admin console release." />;
}
