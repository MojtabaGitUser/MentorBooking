import { cn } from '@/lib/utils';
import { avatarTone, initials } from '@/lib/format';

const tones = [
  'bg-indigo-100 text-indigo-800 dark:bg-indigo-950 dark:text-indigo-200',
  'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-200',
  'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200',
  'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
  'bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-200',
  'bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-200',
];

// The API has no profile photos, so every person gets a stable initials avatar (the name is
// always shown next to it, so the avatar itself is decorative).
export function InitialsAvatar({ name, seed, className }: { name: string; seed: string; className?: string }) {
  return (
    <span aria-hidden className={cn('inline-flex shrink-0 select-none items-center justify-center rounded-full font-semibold', tones[avatarTone(seed, tones.length)], className)}>
      {initials(name)}
    </span>
  );
}
