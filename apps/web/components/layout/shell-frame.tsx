'use client';

import { createContext, useContext, useState, type ReactNode } from 'react';
import { SIDEBAR_COOKIE } from '@/lib/navigation';
const ShellContext = createContext<{ collapsed: boolean; toggle: () => void } | null>(null);

// React owns the collapsed state (seeded from the cookie on the server), so a server refresh can
// never reset it under the user, and the first paint already has the right width.
export function ShellFrame({ initiallyCollapsed, children }: { initiallyCollapsed: boolean; children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(initiallyCollapsed);
  const toggle = () => setCollapsed(previous => {
    const next = !previous;
    document.cookie = `${SIDEBAR_COOKIE}=${next ? 'collapsed' : 'expanded'}; path=/; max-age=31536000; samesite=lax`;
    return next;
  });
  return (
    <ShellContext.Provider value={{ collapsed, toggle }}>
      <div data-shell data-collapsed={collapsed} className="group/shell flex min-h-dvh">{children}</div>
    </ShellContext.Provider>
  );
}

export function useShell() {
  const value = useContext(ShellContext);
  if (!value) throw new Error('useShell must be used inside ShellFrame');
  return value;
}
