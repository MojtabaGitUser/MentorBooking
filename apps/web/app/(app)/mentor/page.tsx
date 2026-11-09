import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { WorkspaceOverview } from '@/components/layout/workspace-overview';
import { currentUser, homeFor } from '@/lib/session';

export const metadata: Metadata = { title: 'Mentor dashboard' };

export default async function MentorHome() {
  const user = (await currentUser())!;
  if (user.role !== 'mentor') redirect(homeFor(user.role));
  return <WorkspaceOverview user={user} title={`Welcome, ${user.displayName.split(' ')[0]}`}
    description="Your mentor workspace. Session and availability management arrive in the mentor dashboard release." />;
}
