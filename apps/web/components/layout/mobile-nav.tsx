'use client';

import { Menu } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTrigger } from '@/components/ui/sheet';
import type { NavItem } from '@/lib/navigation';
import { Brand } from './brand';
import { SidebarNav } from './sidebar-nav';

export function MobileNav({ items, roleLabel }: { items: NavItem[]; roleLabel: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon" className="text-muted-foreground lg:hidden">
          <Menu aria-hidden /><span className="sr-only">Open navigation</span>
        </Button>
      </SheetTrigger>
      <SheetContent title="Navigation">
        <div className="flex h-16 items-center px-5"><Brand /></div>
        <nav aria-label="Main" className="flex-1 overflow-y-auto px-3 py-4">
          <p className="px-3 pb-2 text-xs font-medium uppercase tracking-wider text-sidebar-muted">{roleLabel}</p>
          <SidebarNav items={items} onNavigate={() => setOpen(false)} />
        </nav>
      </SheetContent>
    </Sheet>
  );
}
