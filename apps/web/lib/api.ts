import { cookies } from 'next/headers';

// Server-side only (uses request cookies). The browser never calls the API directly, so no API URL
// or identity header is exposed to client code and no CORS configuration is needed.
export const SESSION_COOKIE = 'mb_demo_user';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
  get isNetwork() { return this.status === 0; }
}

export function apiBaseUrl() {
  return process.env.API_BASE_URL ?? 'http://localhost:3001';
}

export async function sessionUserId() {
  const id = (await cookies()).get(SESSION_COOKIE)?.value;
  return id && UUID.test(id) ? id : null;
}

// GET a JSON resource as the signed-in demo user (or as `userId`). Errors are normalised into
// ApiError with the API's stable `code`; nothing is swallowed.
export async function apiGet<T>(path: string, options: { userId?: string | null } = {}): Promise<T> {
  const userId = options.userId === undefined ? await sessionUserId() : options.userId;
  let response: Response;
  try {
    response = await fetch(new URL(path, apiBaseUrl()), {
      headers: userId ? { 'X-User-Id': userId } : {},
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'The booking service could not be reached.');
  }
  const body = await response.json().catch(() => null) as { code?: string; message?: string } | null;
  if (!response.ok) {
    throw new ApiError(response.status, body?.code ?? `HTTP_${response.status}`, body?.message ?? 'The request failed.');
  }
  return body as T;
}
