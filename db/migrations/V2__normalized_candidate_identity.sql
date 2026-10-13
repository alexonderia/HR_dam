-- Existing rows are preserved. The API serializes identity checks with advisory locks.
CREATE INDEX candidates_normalized_name_idx ON candidates (
  lower(replace(last_name, 'ё', 'е')),
  lower(replace(first_name, 'ё', 'е')),
  lower(replace(coalesce(middle_name, ''), 'ё', 'е'))
);
CREATE INDEX resumes_scoring_queue_idx ON resumes (scoring_status, updated_at);
CREATE INDEX resume_events_resume_created_idx ON resume_events (resume_id, created_at);
