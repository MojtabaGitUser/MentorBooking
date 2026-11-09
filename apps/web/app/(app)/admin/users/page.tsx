import { AdminConsole, type Search } from '@/components/dashboard/admin-console';
export const metadata = { title: 'Users' };
export default function Page({ searchParams }: { searchParams: Search }) {
  return <AdminConsole searchParams={searchParams} path="/admin/users" title="Users" />;
}
