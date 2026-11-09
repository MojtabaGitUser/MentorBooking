'use client';

import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useShell } from './shell-frame';

export function SidebarToggle() {
  const { collapsed, toggle } = useShell();
  return (
    <Button variant="ghost" size="icon" onClick={toggle} aria-expanded={!collapsed} aria-controls="app-sidebar"
      className="hidden text-muted-foreground lg:inline-flex">
      {collapsed ? <PanelLeftOpen aria-hidden /> : <PanelLeftClose aria-hidden />}
      <span className="sr-only">{collapsed ? 'Expand sidebar' : 'Collapse sidebar'}</span>
    </Button>
  );
}
