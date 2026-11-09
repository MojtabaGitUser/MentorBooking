import { AdminConsole, type Search } from '@/components/dashboard/admin-console';
export const metadata = { title: 'Ledger / audit' };
export default function Page({ searchParams }: { searchParams: Search }) {
  return <AdminConsole searchParams={searchParams} path="/admin/ledger" title="Ledger / audit" />;
}
