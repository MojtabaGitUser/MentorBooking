import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import { Pool } from 'pg';

const FILTERS = {
  upcoming: `s.status IN ('scheduled','in_progress')`,
  past: `s.status NOT IN ('scheduled','in_progress')`,
} as const;

// Lists the caller's own sessions only: the owner column comes from authentication, never the query.
@Injectable()
export class SessionListService {
  constructor(private readonly pool: Pool) {}

  async list(userId: string, as: 'mentee' | 'mentor', status?: unknown) {
    if (status !== undefined && status !== 'upcoming' && status !== 'past') {
      throw new UnprocessableEntityException({ code: 'INVALID_SESSION_QUERY', message: 'status must be upcoming or past.' });
    }
    const [own, other] = as === 'mentee' ? ['mentee_id', 'mentor_id'] : ['mentor_id', 'mentee_id'];
    const filter = status ? `AND ${FILTERS[status as keyof typeof FILTERS]}` : '';
    const order = status === 'past' ? 'DESC' : 'ASC';
    const { rows } = await this.pool.query(`SELECT s.id AS "sessionId", s.status,
        json_build_object('id', u.id, 'displayName', u.display_name, 'timezone', u.timezone) AS counterpart,
        s.starts_at AS "startsAt", s.ends_at AS "endsAt", s.joined_mentor_at AS "joinedMentorAt",
        s.joined_mentee_at AS "joinedMenteeAt", s.cancelled_at AS "cancelledAt",
        CASE WHEN s.status <> 'cancelled' THEN NULL WHEN s.cancellation_actor=s.mentor_id THEN 'mentor' ELSE 'mentee' END AS "cancelledBy"
      FROM sessions s JOIN users u ON u.id=s.${other}
      WHERE s.${own}=$1 ${filter} ORDER BY s.starts_at ${order}, s.id`, [userId]);
    const key = as === 'mentee' ? 'mentor' : 'mentee';
    return { items: rows.map(({ counterpart, ...row }) => ({ ...row, [key]: counterpart })) };
  }
}
