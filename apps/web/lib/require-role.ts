import { redirect } from 'next/navigation';
import { currentUser, homeFor } from './session';
import type { Role } from './types';
export async function requireRole(role: Role) {
  const user = await currentUser();
  if (!user) redirect('/?error=signin-required');
  if (user.role !== role) redirect(homeFor(user.role));
  return user;
}
