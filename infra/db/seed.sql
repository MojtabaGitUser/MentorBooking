INSERT INTO users (id, role, display_name, timezone) VALUES
  ('00000000-0000-4000-8000-000000000001', 'mentor', 'Amelia Reed', 'Europe/London'),
  ('00000000-0000-4000-8000-000000000002', 'mentor', 'Ravi Sen', 'Asia/Kolkata'),
  ('00000000-0000-4000-8000-000000000003', 'mentee', 'Alex Chen', 'America/Vancouver'),
  ('00000000-0000-4000-8000-000000000004', 'mentee', 'Sam Rivera', 'America/New_York'),
  ('00000000-0000-4000-8000-000000000005', 'admin', 'Demo Admin', 'UTC')
ON CONFLICT (id) DO NOTHING;

INSERT INTO mentor_profiles (mentor_id) VALUES
  ('00000000-0000-4000-8000-000000000001'),
  ('00000000-0000-4000-8000-000000000002')
ON CONFLICT (mentor_id) DO NOTHING;
