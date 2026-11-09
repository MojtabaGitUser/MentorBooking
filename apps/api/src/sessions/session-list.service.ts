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
    const history = as === 'mentee' && status === 'past';
    const movements = history ? `LEFT JOIN (
      SELECT e.session_id, json_agg(json_build_object('id',e.id,'kind',e.kind,'delta',e.delta,
        'creditType',l.credit_type,'expiresAt',l.expires_at) ORDER BY e.created_at,e.id) AS entries
      FROM ledger_entries e JOIN credit_lots l ON l.id=e.lot_id
      WHERE e.mentee_id=$1 AND e.session_id IS NOT NULL GROUP BY e.session_id
    ) m ON m.session_id=s.id` : '';
    const { rows } = await this.pool.query(`SELECT s.id AS "sessionId", s.status,
        json_build_object('id', u.id, 'displayName', u.display_name, 'timezone', u.timezone) AS counterpart,
        s.starts_at AS "startsAt", s.ends_at AS "endsAt", s.joined_mentor_at AS "joinedMentorAt",
        s.joined_mentee_at AS "joinedMenteeAt", s.cancelled_at AS "cancelledAt",
        CASE WHEN s.status <> 'cancelled' THEN NULL WHEN s.cancellation_actor=s.mentor_id THEN 'mentor' ELSE 'mentee' END AS "cancelledBy"
        ${history ? `, COALESCE(m.entries,'[]') AS "creditActivity"` : ''}
      FROM sessions s JOIN users u ON u.id=s.${other}
      ${movements}
      WHERE s.${own}=$1 ${filter} ORDER BY s.starts_at ${order}, s.id`, [userId]);
    const key = as === 'mentee' ? 'mentor' : 'mentee';
    return { items: rows.map(({ counterpart, ...row }) => ({ ...row, [key]: counterpart })) };
  }
}
