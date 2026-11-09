import { Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { IANAZone } from 'luxon';
import { Pool } from 'pg';

const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
export const MAX_QUERY_LENGTH = 100;

function invalid(message: string): never {
  throw new UnprocessableEntityException({ code: 'INVALID_DIRECTORY_QUERY', message });
}

export function directoryQuery(query: Record<string, unknown>) {
  if (Object.keys(query).some(key => !['q', 'timezone'].includes(key))) invalid('Unexpected query parameter.');
  const { q, timezone } = query;
  if (q !== undefined && (typeof q !== 'string' || q.length > MAX_QUERY_LENGTH)) invalid(`q must be at most ${MAX_QUERY_LENGTH} characters.`);
  if (timezone !== undefined && (typeof timezone !== 'string' || !IANAZone.isValidZone(timezone) || /^[+-]/.test(timezone))) {
    invalid('timezone must be an IANA zone such as Europe/London.');
  }
  const term = typeof q === 'string' ? q.trim().replace(/\s+/g, ' ') : '';
  return { q: term || null, timezone: (timezone as string | undefined) ?? null };
}

// LIKE metacharacters in user input are matched literally.
const likePattern = (term: string) => '%' + term.replace(/[\\%_]/g, char => '\\' + char) + '%';

// Public mentor directory (US-04). Only public profile fields leave this service: no wallet,
// payment, session or account data.
@Injectable()
export class DirectoryService {
  constructor(private readonly pool: Pool) {}

  async list(query: Record<string, unknown>) {
    const filter = directoryQuery(query);
    const { rows: items } = await this.pool.query(`SELECT u.id, u.display_name AS "displayName", u.timezone, p.bio,
        COALESCE((SELECT array_agg(DISTINCT w.weekday ORDER BY w.weekday) FROM weekly_availability w
          WHERE w.mentor_id=p.mentor_id AND w.is_active), '{}') AS "availableWeekdays"
      FROM mentor_profiles p JOIN users u ON u.id=p.mentor_id
      WHERE ($1::text IS NULL OR u.display_name ILIKE $1 OR p.bio ILIKE $1)
        AND ($2::text IS NULL OR u.timezone=$2)
      ORDER BY lower(u.display_name), u.id`, [filter.q && likePattern(filter.q), filter.timezone]);
    // Facets describe the whole directory, so the filter offers every zone regardless of the current search.
    const { rows: timezones } = await this.pool.query(`SELECT u.timezone, count(*)::int AS count
      FROM mentor_profiles p JOIN users u ON u.id=p.mentor_id GROUP BY u.timezone ORDER BY u.timezone`);
    return { items, total: items.length, filters: { q: filter.q, timezone: filter.timezone }, facets: { timezones } };
  }

  async profile(id: string) {
    const missing = () => new NotFoundException({ code: 'MENTOR_NOT_FOUND', message: 'Mentor not found.' });
    if (!uuid.test(id)) throw missing();
    const { rows: [mentor] } = await this.pool.query(`SELECT u.id, u.display_name AS "displayName", u.timezone, p.bio
      FROM mentor_profiles p JOIN users u ON u.id=p.mentor_id WHERE p.mentor_id=$1`, [id]);
    if (!mentor) throw missing();
    const { rows: weeklyAvailability } = await this.pool.query(`SELECT weekday,
        to_char(start_local,'HH24:MI') AS "startLocal", to_char(end_local,'HH24:MI') AS "endLocal"
      FROM weekly_availability WHERE mentor_id=$1 AND is_active ORDER BY weekday, start_local`, [id]);
    return { ...mentor, availableWeekdays: [...new Set(weeklyAvailability.map(rule => rule.weekday))], weeklyAvailability };
  }
}
