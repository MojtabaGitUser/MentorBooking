import { ConflictException } from '@nestjs/common';

// Timing constants from the US-14 contract (design decision B4). Elapsed time on UTC instants only.
export const EARLY_JOIN_MS = 5 * 60_000;         // join opens 5 minutes before the official start
export const RESOLUTION_GRACE_MS = 5 * 60_000;   // attendance is resolved 5 minutes after the end
export const NO_SHOW_ROLLOVER_MS = 30 * 24 * 60 * 60_000; // exactly 720 elapsed hours, independent of DST

export const TERMINAL = ['completed', 'no_show_mentee', 'no_show_mentor', 'cancelled'] as const;
export type SessionStatus = 'scheduled' | 'in_progress' | typeof TERMINAL[number];
export type Outcome = 'completed' | 'no_show_mentee' | 'no_show_mentor';

// Allowed edges of the state machine. Terminal states have none.
const EDGES: Record<SessionStatus, SessionStatus[]> = {
  scheduled: ['in_progress', 'cancelled', 'completed', 'no_show_mentee', 'no_show_mentor'],
  in_progress: ['completed', 'no_show_mentee', 'no_show_mentor', 'cancelled'],
  completed: [], no_show_mentee: [], no_show_mentor: [], cancelled: [],
};
export function canTransition(from: string, to: SessionStatus) {
  return (EDGES[from as SessionStatus] ?? []).includes(to);
}
export const isTerminal = (status: string) => (TERMINAL as readonly string[]).includes(status);

export interface Attendance {
  joinedMentorAt: Date | null;
  joinedMenteeAt: Date | null;
}

// B4: both joined -> completed; mentor only -> mentee no-show; mentee only -> mentor no-show;
// neither -> mentee no-show (documented simplification: the mentee forfeits, no rollover).
export function classifyAttendance({ joinedMentorAt, joinedMenteeAt }: Attendance): Outcome {
  if (joinedMentorAt && joinedMenteeAt) return 'completed';
  if (joinedMenteeAt) return 'no_show_mentor';
  return 'no_show_mentee';
}

export const resolutionDueAt = (endsAt: Date) => new Date(endsAt.getTime() + RESOLUTION_GRACE_MS);
export const rolloverExpiresAt = (awardedAt: Date) => new Date(awardedAt.getTime() + NO_SHOW_ROLLOVER_MS);

export type JoinDecision = 'record' | 'record_and_start';

// Join window is [startsAt - 5 min, endsAt). Before the start only attendance is recorded; at or after
// the start a still-scheduled session is first moved to in_progress (the official start has passed).
export function joinDecision(session: { status: string; startsAt: Date; endsAt: Date }, now: Date): JoinDecision {
  if (session.status !== 'scheduled' && session.status !== 'in_progress') {
    throw new ConflictException({ code: 'SESSION_NOT_JOINABLE', message: 'This session can no longer be joined.',
      details: { status: session.status } });
  }
  const opensAt = new Date(session.startsAt.getTime() - EARLY_JOIN_MS);
  if (now.getTime() < opensAt.getTime()) {
    throw new ConflictException({ code: 'JOIN_WINDOW_NOT_OPEN', message: 'You can join from 5 minutes before the start.',
      details: { opensAt: opensAt.toISOString() } });
  }
  if (now.getTime() >= session.endsAt.getTime()) {
    throw new ConflictException({ code: 'JOIN_WINDOW_CLOSED', message: 'This session has ended.',
      details: { closedAt: session.endsAt.toISOString() } });
  }
  return session.status === 'scheduled' && now.getTime() >= session.startsAt.getTime() ? 'record_and_start' : 'record';
}
