import type { ReactNode } from 'react';
import { ApiError } from '@/lib/api';
import { ErrorState } from './error-state';

// Maps a normalised API error onto a user-facing state. 404 is handled by the caller (notFound()).
export function ApiErrorState({ error, forbidden }: { error: unknown; forbidden?: { title: string; description: string; action: ReactNode } }) {
  if (error instanceof ApiError && error.status === 403 && forbidden) {
    return <ErrorState title={forbidden.title} description={forbidden.description} code={error.code} action={forbidden.action} />;
  }
  if (error instanceof ApiError && error.isNetwork) {
    return <ErrorState title="We can't reach the booking service" description="The service may be starting up or temporarily unavailable. Please try again in a moment." code={error.code} />;
  }
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
    return <ErrorState title="This request could not be completed" description={error.message} code={error.code} />;
  }
  return <ErrorState title="Something went wrong" description="An unexpected error occurred while loading this page. Please try again." code={error instanceof ApiError ? error.code : undefined} />;
}
