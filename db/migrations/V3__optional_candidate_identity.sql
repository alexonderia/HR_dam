-- Processing state and import inventory are stored in RabbitMQ.
ALTER TABLE candidates
    ALTER COLUMN phone DROP NOT NULL,
    ALTER COLUMN last_name DROP NOT NULL,
    ALTER COLUMN first_name DROP NOT NULL;
