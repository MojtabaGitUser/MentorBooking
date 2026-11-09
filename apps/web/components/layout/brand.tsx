import { GraduationCap } from 'lucide-react';

export function Brand() {
  return (
    <span className="flex items-center gap-2.5 font-semibold tracking-tight text-white">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-indigo-500 text-white shadow-sm">
        <GraduationCap className="size-[18px]" aria-hidden />
      </span>
      <span className="group-data-[collapsed=true]/shell:lg:sr-only">Mentor Booking</span>
    </span>
  );
}
