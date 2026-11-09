'use server';
import { revalidatePath } from 'next/cache';
import { asAccount } from '@/lib/account-action';
import { apiRequest, ApiError } from '@/lib/api';
import type { Adjustment, Receipt } from '@/lib/dashboard';

function resource(id: string) {
  if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(id))
    throw new ApiError(400, 'INVALID_ID', 'Invalid resource identifier.');
  return id;
}
export async function scheduleChange(
  account: string,
  section: 'availability' | 'blockouts',
  method: 'POST' | 'PATCH' | 'DELETE',
  id: string | null,
  body?: unknown,
) {
  return asAccount(account, async () => {
    if (
      !['availability', 'blockouts'].includes(section) ||
      !['POST', 'PATCH', 'DELETE'].includes(method) ||
      (method === 'POST') !== (id === null)
    )
      throw new ApiError(400, 'INVALID_SCHEDULE', 'Invalid schedule operation.');
    await apiRequest('/mentor/' + section + (id === null ? '' : '/' + resource(id)), { method, body });
    revalidatePath('/mentor', 'layout');
    return true;
  });
}
export async function mentorCancel(account: string, id: string, reason: string) {
  return asAccount(account, async () => {
    await apiRequest('/mentor/sessions/' + resource(id) + '/cancel', {
      method: 'POST',
      body: reason.trim() ? { reason: reason.trim() } : {},
    });
    revalidatePath('/mentor', 'layout');
    revalidatePath('/sessions');
    revalidatePath('/wallet', 'layout');
    return true;
  });
}
export async function adjustCredits(account: string, target: string, request: Adjustment) {
  return asAccount(account, async () => {
    const receipt = await apiRequest<Receipt>('/admin/users/' + resource(target) + '/credits/adjust', {
      method: 'POST',
      body: request,
    });
    revalidatePath('/admin', 'layout');
    revalidatePath('/wallet', 'layout');
    return receipt;
  });
}
