'use client';

import { Moon, Sun } from 'lucide-react';
import { useSyncExternalStore } from 'react';
import { Button } from '@/components/ui/button';

// The inline script in app/layout.tsx applies the stored or system theme before first paint;
// this button flips it and remembers the choice.
const subscribe = (notify: () => void) => {
  const observer = new MutationObserver(notify);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  return () => observer.disconnect();
};
const isDark = () => document.documentElement.classList.contains('dark');

export function ThemeToggle() {
  const dark = useSyncExternalStore(subscribe, isDark, () => false);
  const toggle = () => {
    const next = !isDark();
    document.documentElement.classList.toggle('dark', next);
    document.documentElement.style.colorScheme = next ? 'dark' : 'light';
    try { localStorage.setItem('theme', next ? 'dark' : 'light'); } catch { /* private mode */ }
  };
  return (
    <Button variant="ghost" size="icon" onClick={toggle} className="text-muted-foreground" data-testid="theme-toggle">
      {dark ? <Sun aria-hidden /> : <Moon aria-hidden />}
      <span className="sr-only">{dark ? 'Switch to light theme' : 'Switch to dark theme'}</span>
    </Button>
  );
}
