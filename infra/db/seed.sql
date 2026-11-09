INSERT INTO users (id, role, display_name, timezone) VALUES
  ('00000000-0000-4000-8000-000000000001', 'mentor', 'Amelia Reed', 'Europe/London'),
  ('00000000-0000-4000-8000-000000000002', 'mentor', 'Ravi Sen', 'Asia/Kolkata'),
  ('00000000-0000-4000-8000-000000000003', 'mentee', 'Alex Chen', 'America/Vancouver'),
  ('00000000-0000-4000-8000-000000000004', 'mentee', 'Sam Rivera', 'America/New_York'),
  ('00000000-0000-4000-8000-000000000005', 'admin', 'Demo Admin', 'UTC'),
  -- Additional fictional demo mentors for the directory (US-04).
  ('00000000-0000-4000-8000-000000000006', 'mentor', 'Maya Okafor', 'Africa/Lagos'),
  ('00000000-0000-4000-8000-000000000007', 'mentor', 'Lucas Martins', 'America/Sao_Paulo'),
  ('00000000-0000-4000-8000-000000000008', 'mentor', 'Hana Sato', 'Asia/Tokyo')
ON CONFLICT (id) DO NOTHING;

-- Fictional demo personas: short, credential-free descriptions only.
INSERT INTO mentor_profiles (mentor_id, bio) VALUES
  ('00000000-0000-4000-8000-000000000001', 'Product-minded engineer who enjoys untangling messy requirements. Sessions usually cover planning a feature, structuring a codebase or preparing for a design review.'),
  ('00000000-0000-4000-8000-000000000002', 'Backend and data enthusiast. Happy to talk through SQL, API design, debugging production issues and how to grow from junior to mid-level.'),
  ('00000000-0000-4000-8000-000000000006', 'Frontend developer focused on accessible, maintainable interfaces. Bring a component, a layout problem or a question about React and TypeScript.'),
  ('00000000-0000-4000-8000-000000000007', 'Engineering lead who likes helping people with code reviews, estimation, interviews and working effectively in a team.'),
  ('00000000-0000-4000-8000-000000000008', 'Mobile and cloud tinkerer. Good fit for questions about shipping side projects, deployment pipelines and learning a new stack.')
ON CONFLICT (mentor_id) DO NOTHING;

-- Weekly availability for the additional demo mentors, in each mentor's own timezone.
-- (The first two mentors start without rules; their availability is managed in the US-05 demo.)
INSERT INTO weekly_availability (id, mentor_id, weekday, start_local, end_local) VALUES
  ('00000000-0000-4000-8000-000000000601', '00000000-0000-4000-8000-000000000006', 1, '09:00', '12:00'),
  ('00000000-0000-4000-8000-000000000602', '00000000-0000-4000-8000-000000000006', 3, '14:00', '17:00'),
  ('00000000-0000-4000-8000-000000000701', '00000000-0000-4000-8000-000000000007', 2, '18:00', '21:00'),
  ('00000000-0000-4000-8000-000000000702', '00000000-0000-4000-8000-000000000007', 4, '18:00', '21:00'),
  ('00000000-0000-4000-8000-000000000801', '00000000-0000-4000-8000-000000000008', 5, '08:00', '11:00'),
  ('00000000-0000-4000-8000-000000000802', '00000000-0000-4000-8000-000000000008', 6, '10:00', '12:00')
ON CONFLICT (id) DO NOTHING;
