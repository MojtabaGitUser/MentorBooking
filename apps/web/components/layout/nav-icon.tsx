import { CalendarDays, Clock, Coins, Compass, History, LayoutDashboard, ScrollText, UserRound, Users, Wallet, type LucideIcon } from 'lucide-react';
import type { NavIcon as Name } from '@/lib/navigation';

const ICONS: Record<Name, LucideIcon> = {
  compass: Compass, calendar: CalendarDays, wallet: Wallet, history: History, user: UserRound,
  layout: LayoutDashboard, clock: Clock, users: Users, coins: Coins, scroll: ScrollText,
};

export function NavIcon({ name, className }: { name: Name; className?: string }) {
  const Icon = ICONS[name];
  return <Icon aria-hidden className={className} />;
}
