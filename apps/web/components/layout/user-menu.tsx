'use client';

import { ChevronDown, Globe, LogOut, Repeat } from 'lucide-react';
import Link from 'next/link';
import { signOut } from '@/app/actions';
import { InitialsAvatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import type { CurrentUser } from '@/lib/types';

export function UserMenu({ user, roleLabel }: { user: CurrentUser; roleLabel: string }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex h-10 items-center gap-2 rounded-lg px-1.5 text-left hover:bg-accent sm:px-2">
        <InitialsAvatar name={user.displayName} seed={user.id} className="size-8 text-xs" />
        <span className="hidden min-w-0 sm:block">
          <span className="block truncate text-sm font-medium leading-tight">{user.displayName}</span>
          <span className="block text-xs leading-tight text-muted-foreground">{roleLabel}</span>
        </span>
        <ChevronDown className="hidden size-4 text-muted-foreground sm:block" aria-hidden />
        <span className="sr-only">Account menu for {user.displayName}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>
          <span className="block text-sm font-medium">{user.displayName}</span>
          <span className="mt-1 flex items-center gap-2 text-xs font-normal text-muted-foreground">
            <Badge variant="neutral">{roleLabel}</Badge>
            <Globe className="size-3" aria-hidden />{user.timezone}
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild><Link href="/?switch=1"><Repeat aria-hidden />Switch demo account</Link></DropdownMenuItem>
        <DropdownMenuItem onSelect={() => { void signOut(); }}><LogOut aria-hidden />Sign out</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
