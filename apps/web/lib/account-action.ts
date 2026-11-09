import { ApiError, bookingAccountScope, sessionUserId } from './api';

export async function asAccount<T>(expected: string, operation: () => Promise<T>) {
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
