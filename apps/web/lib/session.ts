import { ApiError, apiGet, sessionUserId } from './api';
import type { CurrentUser, Role } from './types';

// Demo identity (US-03): the selected seeded account's ID is kept in an httpOnly cookie and sent as
// X-User-Id. The API decides who the user is and what they may do; the UI only adapts to it.
export async function currentUser(): Promise<CurrentUser | null> {
  const id = await sessionUserId();
  if (!id) return null;
  try {
    return await apiGet<CurrentUser>('/me', { userId: id });
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null;
    throw error;
  }
}

export function homeFor(role: Role) {
  return role === 'mentee' ? '/mentors' : role === 'mentor' ? '/mentor' : '/admin';
}

// Seeded demo accounts (infra/db/seed.sql). Names and roles shown on the sign-in page are read from
// the API, not from this list.
export const DEMO_ACCOUNT_IDS = [3, 4, 1, 2, 6, 7, 8, 5].map(n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
