import type { ReactNode } from 'react';
import './globals.css';

export const metadata = { title: 'Mentor Booking' };

export default function Layout({ children }: { children: ReactNode }) {
  return <html lang="en"><body className="bg-stone-50 text-stone-900">{children}</body></html>;
}
