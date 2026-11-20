-- Keep the previous verified ratings and their requirements when reassessing.
CREATE TABLE resume_rating_history (
    id UUID PRIMARY KEY,
    resume_id UUID NOT NULL REFERENCES resumes(id) ON DELETE CASCADE,
    replacement_job_id UUID NOT NULL,
    ratings JSONB NOT NULL,
    assessments JSONB NOT NULL,
    archived_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (resume_id, replacement_job_id)
);
CREATE INDEX resume_rating_history_resume_idx ON resume_rating_history(resume_id, archived_at);
