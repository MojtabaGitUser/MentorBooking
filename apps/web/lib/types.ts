// Shapes returned by the NestJS API (see README "Mentor directory").
export type Role = 'mentee' | 'mentor' | 'admin';

export interface CurrentUser {
  id: string;
  role: Role;
  displayName: string;
  timezone: string;
}

export interface MentorSummary {
  id: string;
  displayName: string;
  timezone: string;
  bio: string;
  availableWeekdays: number[];
}

export interface DirectoryResponse {
  items: MentorSummary[];
  total: number;
  filters: { q: string | null; timezone: string | null };
  facets: { timezones: { timezone: string; count: number }[] };
}

export interface MentorProfile extends MentorSummary {
  weeklyAvailability: { weekday: number; startLocal: string; endLocal: string }[];
}

export interface SlotPreview {
  mentorTimezone: string;
  viewerTimezone: string;
  slots: { startsAt: string; endsAt: string; localStartsAt: string; localEndsAt: string }[];
}
