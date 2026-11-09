'use server';

import { revalidatePath } from 'next/cache';
import { apiRequest, ApiError, bookingAccountScope, sessionUserId } from '@/lib/api';
import type { RefundPreview } from '@/lib/types';

async function asAccount<T>(expected: string, operation: () => Promise<T>) {
  try {
    const id = await sessionUserId();
    if (!id || bookingAccountScope(id) !== expected)
      throw new ApiError(401, 'ACCOUNT_CHANGED', 'Your account changed. Reopen this page.');
    return { ok: true as const, value: await operation() };
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    return {
      ok: false as const,
      status: error.status,
      code: error.code,
      message: error.message,
      preview: error.details?.currentPreview,
    };
  }
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
