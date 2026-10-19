CREATE TABLE resume_cluster_assessments (
    resume_id UUID NOT NULL REFERENCES resumes(id) ON DELETE CASCADE,
    cluster_id UUID NOT NULL REFERENCES clusters(id) ON DELETE CASCADE,
    requirements JSONB NOT NULL,
    assessed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (resume_id, cluster_id)
);
