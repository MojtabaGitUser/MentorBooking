import { AdminConsole, type Search } from '@/components/dashboard/admin-console';
export const metadata = { title: 'Admin dashboard' };
export default function Page({ searchParams }: { searchParams: Search }) {
  return <AdminConsole searchParams={searchParams} path="/admin" title="Admin dashboard" />;
}
