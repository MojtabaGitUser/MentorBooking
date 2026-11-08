import { Activity } from 'lucide-react';
import type { HealthReport } from '@mentor/shared';

export const dynamic = 'force-dynamic';

async function readHealth(): Promise<HealthReport | undefined> {
  try {
    const base = process.env.API_BASE_URL ?? 'http://localhost:3001';
    const response = await fetch(new URL('/health', base), {
      cache: 'no-store',
      signal: AbortSignal.timeout(3500),
    });
    if (response.ok || response.status === 503) return await response.json();
  } catch {
    // Keep the development status page reachable while the API is starting.
  }
}

export default async function Page() {
  const health = await readHealth();
  return (
    <main className="mx-auto max-w-xl px-6 py-20">
      <h1 className="text-3xl font-semibold tracking-tight">Mentor Booking</h1>
      <section className="mt-8 rounded-lg border border-stone-200 bg-white p-5">
        <h2 className="flex items-center gap-2 font-medium"><Activity size={18} aria-hidden />Service status</h2>
        <dl className="mt-4 grid grid-cols-2 gap-2 text-sm">
          <dt>API</dt><dd>{health ? 'Reachable' : 'Unavailable'}</dd>
          <dt>PostgreSQL</dt><dd>{health ? (health.database === 'up' ? 'Connected' : 'Disconnected') : 'Unknown'}</dd>
        </dl>
      </section>
    </main>
  );
}
