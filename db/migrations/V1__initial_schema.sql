-- Source of truth: docs/candidate_matching_architecture.md.
-- clusters.track: the two allowed values are unspecified; no invented CHECK.
CREATE TABLE clusters (
    id UUID PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    track VARCHAR(20) NOT NULL,
    comment TEXT,
    is_active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE profiles (
    id UUID PRIMARY KEY,
    cluster_id UUID NOT NULL REFERENCES clusters(id),
    position_name VARCHAR(255) NOT NULL,
    education TEXT,
    experience TEXT,
    keywords TEXT[],
    stop_factors TEXT[],
    comment TEXT,
    is_active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE candidates (
    id UUID PRIMARY KEY,
    phone VARCHAR(20) NOT NULL UNIQUE,
    last_name VARCHAR(100) NOT NULL,
    first_name VARCHAR(100) NOT NULL,
    middle_name VARCHAR(100),
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE candidate_blacklist (
    id UUID PRIMARY KEY,
    phone VARCHAR(20) NOT NULL,
    last_name VARCHAR(100) NOT NULL,
    first_name VARCHAR(100) NOT NULL,
    middle_name VARCHAR(100),
    company_name VARCHAR(255) NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE files (
    id UUID PRIMARY KEY,
    bucket VARCHAR(255) NOT NULL,
    object_key TEXT NOT NULL,
    file_name TEXT NOT NULL,
    mime_type VARCHAR(100),
    size_bytes BIGINT,
    file_sha256 CHAR(64),
    created_at TIMESTAMPTZ NOT NULL,
    UNIQUE (bucket, object_key)
);

CREATE TABLE resumes (
    id UUID PRIMARY KEY,
    candidate_id UUID NOT NULL UNIQUE REFERENCES candidates(id),
    file_id UUID NOT NULL UNIQUE REFERENCES files(id),
    status VARCHAR(20) NOT NULL
        CHECK (status IN ('in_work', 'in_process', 'historical')),
    scoring_status VARCHAR(20) NOT NULL
        CHECK (scoring_status IN ('pending', 'processing', 'completed', 'failed')),
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE profile_ratings (
    id UUID PRIMARY KEY,
    resume_id UUID NOT NULL REFERENCES resumes(id),
    profile_id UUID NOT NULL REFERENCES profiles(id),
    score NUMERIC(5,2) NOT NULL CHECK (score BETWEEN 0 AND 100),
    matched_keywords JSONB,
    triggered_stop_factors JSONB,
    details JSONB,
    explanation TEXT,
    calculated_at TIMESTAMPTZ NOT NULL,
    UNIQUE (resume_id, profile_id)
);

CREATE TABLE resume_events (
    id UUID PRIMARY KEY,
    resume_id UUID NOT NULL REFERENCES resumes(id),
    event_type VARCHAR(50) NOT NULL
        CHECK (event_type IN (
            'uploaded', 'replaced', 'replacement_rejected',
            'scored', 'scoring_failed', 'status_changed'
        )),
    actor_id UUID,
    recipient_id UUID,
    message TEXT,
    created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX profiles_cluster_id_idx ON profiles (cluster_id);
CREATE INDEX candidate_blacklist_active_identity_idx
    ON candidate_blacklist (phone, last_name, first_name, middle_name)
    WHERE is_active = TRUE;
