'use server';

import { revalidatePath } from 'next/cache';
import { apiRequest, ApiError } from '@/lib/api';
import type { RefundPreview } from '@/lib/types';

import { asAccount } from '@/lib/account-action';

export async function purchasePack(account: string) {
  return asAccount(account, async () => {
    await apiRequest('/payments/purchases', { method: 'POST', body: { packCredits: 4 } });
    revalidatePath('/wallet');
    return true;
  });
}

export async function reserve(account: string, mentorId: string, startsAt: string, key: string) {
  return asAccount(account, async () => {
    if (typeof key !== 'string' || !key)
      throw new ApiError(422, 'INVALID_KEY', 'A booking reference is required.');
    const result = await apiRequest<{ sessionId: string; startsAt: string; endsAt: string; status: string }>(
      '/sessions',
      { method: 'POST', key, body: { mentorId, startsAt } },
    );
    revalidatePath('/sessions');
    revalidatePath('/wallet', 'layout');
    return result;
  });
}

export async function previewCancellation(account: string, id: string) {
  return asAccount(account, () =>
    apiRequest<RefundPreview>(`/sessions/${encodeURIComponent(id)}/cancellation-preview`),
  );
}

export async function cancelBooking(account: string, id: string, expectedRefundableCredits: 0 | 1) {
  return asAccount(account, async () => {
    const result = await apiRequest<{ cancelledBy: string; refund: { credits: number } }>(
      `/sessions/${encodeURIComponent(id)}/cancel`,
      { method: 'POST', body: { expectedRefundableCredits } },
    );
    revalidatePath('/sessions');
    revalidatePath('/wallet', 'layout');
    return result;
  });
}

export async function joinBooking(account: string, id: string) {
  return asAccount(account, async () => {
    await apiRequest(`/sessions/${encodeURIComponent(id)}/join`, { method: 'POST' });
    revalidatePath('/sessions');
    return true;
  });
}
