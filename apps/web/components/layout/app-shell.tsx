import { Globe } from 'lucide-react';
import { cookies } from 'next/headers';
import type { ReactNode } from 'react';
import { zoneCity, zoneOffset } from '@/lib/format';
import { NAVIGATION, ROLE_LABEL, SIDEBAR_COOKIE } from '@/lib/navigation';
import type { CurrentUser } from '@/lib/types';
import { Brand } from './brand';
import { MobileNav } from './mobile-nav';
import { SidebarNav } from './sidebar-nav';
import { ShellFrame } from './shell-frame';
import { SidebarToggle } from './sidebar-toggle';
import { ThemeToggle } from './theme-toggle';
import { UserMenu } from './user-menu';

// Dashboard shell: dark collapsible sidebar (desktop), drawer (mobile), header with timezone,
// theme and account controls. Layout pattern inspired by Shadboard; no template code copied.
export async function AppShell({ user, children }: { user: CurrentUser; children: ReactNode }) {
  const collapsed = (await cookies()).get(SIDEBAR_COOKIE)?.value === 'collapsed';
  const items = NAVIGATION[user.role];
  const roleLabel = ROLE_LABEL[user.role];
  return (
    <ShellFrame initiallyCollapsed={collapsed}>
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[60] focus:rounded-md focus:bg-card focus:px-4 focus:py-2 focus:text-sm focus:shadow-raised">Skip to content</a>
      {/* The coloured column spans the full page height; the navigation inside it stays in view. */}
      <div className="hidden w-64 shrink-0 bg-sidebar transition-[width] duration-200 group-data-[collapsed=true]/shell:w-[4.5rem] lg:block">
      <aside id="app-sidebar" className="sticky top-0 flex h-dvh flex-col text-sidebar-foreground">
        <div className="flex h-16 items-center px-5 group-data-[collapsed=true]/shell:justify-center group-data-[collapsed=true]/shell:px-0"><Brand /></div>
        <nav aria-label="Main" className="flex-1 overflow-y-auto px-3 py-4">
          <p className="px-3 pb-2 text-xs font-medium uppercase tracking-wider text-sidebar-muted group-data-[collapsed=true]/shell:sr-only">{roleLabel}</p>
          <SidebarNav items={items} />
        </nav>
        <p className="mx-3 mb-4 rounded-lg border border-sidebar-border px-3 py-2.5 text-xs leading-relaxed text-sidebar-muted group-data-[collapsed=true]/shell:hidden">
          Demo environment. Accounts use the seeded demo sign-in.
        </p>
      </aside>
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-16 items-center gap-2 border-b border-border bg-background/85 px-3 backdrop-blur supports-[backdrop-filter]:bg-background/70 sm:px-6">
          <MobileNav items={items} roleLabel={roleLabel} />
          <SidebarToggle />
          <div className="ml-auto flex items-center gap-1 sm:gap-2">
            <span className="hidden items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 text-xs text-muted-foreground md:flex" title={user.timezone}>
              <Globe className="size-3.5" aria-hidden />
              <span>Times in {zoneCity(user.timezone)} ({zoneOffset(user.timezone, new Date())})</span>
            </span>
            <ThemeToggle />
            <UserMenu user={user} roleLabel={roleLabel} />
          </div>
        </header>
        <main id="main" tabIndex={-1} className="flex-1 px-4 py-6 outline-none sm:px-6 lg:px-8 lg:py-8">
          <div className="mx-auto w-full max-w-6xl">{children}</div>
        </main>
      </div>
    </ShellFrame>
  );
}
