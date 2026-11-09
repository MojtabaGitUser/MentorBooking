import type { Role } from './types';

export type NavIcon = 'compass' | 'calendar' | 'wallet' | 'history' | 'user' | 'layout' | 'clock' | 'users' | 'coins' | 'scroll';

export interface NavItem {
  label: string;
  href: string;
  icon: NavIcon;
  // 'upcoming' items are shown disabled with a "Soon" label until their story ships.
  status: 'ready' | 'upcoming';
  story?: string;
}

// Role-aware navigation. Routes are fixed now so US-16 to US-18 only flip `status`.
export const NAVIGATION: Record<Role, NavItem[]> = {
  mentee: [
    { label: 'Discover mentors', href: '/mentors', icon: 'compass', status: 'ready' },
    { label: 'My sessions', href: '/sessions', icon: 'calendar', status: 'ready' },
    { label: 'My wallet', href: '/wallet', icon: 'wallet', status: 'ready' },
    { label: 'History', href: '/wallet/history', icon: 'history', status: 'ready' },
    { label: 'Profile', href: '/profile', icon: 'user', status: 'upcoming' },
  ],
  mentor: [
    { label: 'Dashboard', href: '/mentor', icon: 'layout', status: 'ready' },
    { label: 'My sessions', href: '/mentor/sessions', icon: 'calendar', status: 'ready' },
    { label: 'Availability', href: '/mentor/availability', icon: 'clock', status: 'ready' },
    { label: 'Profile', href: '/mentor/profile', icon: 'user', status: 'upcoming' },
  ],
  admin: [
    { label: 'Dashboard', href: '/admin', icon: 'layout', status: 'ready' },
    { label: 'Users', href: '/admin/users', icon: 'users', status: 'ready' },
    { label: 'Credit adjustments', href: '/admin/adjustments', icon: 'coins', status: 'ready' },
    { label: 'Ledger / audit', href: '/admin/ledger', icon: 'scroll', status: 'ready' },
  ],
};

export const ROLE_LABEL: Record<Role, string> = { mentee: 'Mentee', mentor: 'Mentor', admin: 'Admin' };

// Longest matching ready item is active (so /mentors/abc highlights "Discover mentors").
export function activeHref(items: NavItem[], pathname: string) {
  return items.filter(item => item.status === 'ready' && (pathname === item.href || pathname.startsWith(item.href + '/')))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href ?? null;
}

// Shared by the server shell (reads it) and the client toggle (writes it). It must live in a plain
// module: a constant imported from a 'use client' file is a client reference on the server.
export const SIDEBAR_COOKIE = 'mb_sidebar';
