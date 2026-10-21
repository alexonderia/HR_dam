-- No provenance is inferred for historical values: they remain protected.
ALTER TABLE candidates ADD COLUMN contact_provenance JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE resumes ADD COLUMN contact_extraction JSONB;
ALTER TABLE resume_events DROP CONSTRAINT resume_events_event_type_check;
ALTER TABLE resume_events ADD CONSTRAINT resume_events_event_type_check CHECK (event_type IN (
    'uploaded', 'replaced', 'replacement_rejected', 'scored', 'scoring_failed', 'status_changed', 'contacts_recovered'
));
