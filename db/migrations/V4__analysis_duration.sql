ALTER TABLE resume_events
    ADD COLUMN analysis_duration_ms INTEGER CHECK (analysis_duration_ms >= 0);
