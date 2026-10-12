#!/bin/sh
set -eu

: "${S3_ENDPOINT:?S3_ENDPOINT is required}"
: "${S3_BUCKET:?S3_BUCKET is required}"

s3() {
    aws --endpoint-url "$S3_ENDPOINT" --cli-connect-timeout 5 --cli-read-timeout 10 s3api "$@"
}

# Check signed S3 API readiness before attempting any initialization.
attempt=0
until s3 list-buckets >/dev/null; do
    attempt=$((attempt + 1))
    if [ "$attempt" -ge 30 ]; then
        echo "S3 API did not become ready with the configured credentials." >&2
        exit 1
    fi
    sleep 2
done

if s3 head-bucket --bucket "$S3_BUCKET" 2>/tmp/bucket-error; then
    echo "S3 bucket already exists: $S3_BUCKET"
else
    # Only an absent bucket permits creation; do not mask access/network errors.
    if ! grep -Eq '\(404\)|NoSuchBucket|Not Found' /tmp/bucket-error; then
        cat /tmp/bucket-error >&2
        exit 1
    fi
    if [ "$AWS_DEFAULT_REGION" = "us-east-1" ]; then
        s3 create-bucket --bucket "$S3_BUCKET"
    else
        s3 create-bucket --bucket "$S3_BUCKET" \
            --create-bucket-configuration "LocationConstraint=$AWS_DEFAULT_REGION"
    fi
    s3 head-bucket --bucket "$S3_BUCKET"
    echo "S3 bucket created: $S3_BUCKET"
fi
