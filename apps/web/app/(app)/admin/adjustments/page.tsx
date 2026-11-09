import { AdminConsole, type Search } from '@/components/dashboard/admin-console';
export const metadata = { title: 'Credit adjustments' };
export default function Page({ searchParams }: { searchParams: Search }) {
  return <AdminConsole searchParams={searchParams} path="/admin/adjustments" title="Credit adjustments" />;
}
