'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { activeHref, type NavItem } from '@/lib/navigation';
import { cn } from '@/lib/utils';
import { NavIcon } from './nav-icon';

// Ready items are links; upcoming items are visibly disabled (not links) so nothing leads to a dead end.
export function SidebarNav({ items, onNavigate }: { items: NavItem[]; onNavigate?: () => void }) {
  const active = activeHref(items, usePathname());
  return (
    <ul className="flex flex-col gap-1">
      {items.map(item => {
        const label = <span className="truncate group-data-[collapsed=true]/shell:lg:sr-only">{item.label}</span>;
        const base = 'flex h-10 items-center gap-3 rounded-lg px-3 text-sm font-medium group-data-[collapsed=true]/shell:lg:justify-center group-data-[collapsed=true]/shell:lg:px-0';
        if (item.status === 'upcoming') {
          return (
            <li key={item.href}>
              <span aria-disabled="true" title={`${item.label} — coming soon`} className={cn(base, 'cursor-not-allowed text-sidebar-muted')}>
                <NavIcon name={item.icon} className="size-[18px] shrink-0" />
                {label}
                <span className="ml-auto rounded-full border border-sidebar-border px-2 py-0.5 text-[11px] font-medium text-sidebar-muted group-data-[collapsed=true]/shell:lg:hidden">Soon</span>
              </span>
            </li>
          );
        }
        const current = item.href === active;
        return (
          <li key={item.href}>
            <Link href={item.href} onClick={onNavigate} aria-current={current ? 'page' : undefined} title={item.label}
              className={cn(base, 'transition-colors focus-visible:outline-sidebar-primary',
                current ? 'bg-sidebar-accent text-sidebar-accent-foreground shadow-[inset_3px_0_0_var(--color-sidebar-primary)]'
                  : 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground')}>
              <NavIcon name={item.icon} className={cn('size-[18px] shrink-0', current && 'text-sidebar-primary')} />
              {label}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
