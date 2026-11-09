'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { ApiError, apiGet, SESSION_COOKIE } from '@/lib/api';
import { homeFor } from '@/lib/session';
import type { CurrentUser } from '@/lib/types';

// Demo sign-in: remember a seeded account after the API confirms it exists. httpOnly keeps the ID
// out of client scripts. It is a demo identity, not a credential (see README "Demo authentication").
export async function signIn(formData: FormData) {
  const id = String(formData.get('userId') ?? '');
  let user: CurrentUser;
  try {
    user = await apiGet<CurrentUser>('/me', { userId: id });
  } catch (error) {
    redirect('/?error=' + (error instanceof ApiError && error.status === 401 ? 'unknown-account' : 'unavailable'));
  }
  (await cookies()).set(SESSION_COOKIE, user.id, { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 60 * 60 * 8 });
  redirect(homeFor(user.role));
}

export async function signOut() {
  (await cookies()).delete(SESSION_COOKIE);
  redirect('/');
}
