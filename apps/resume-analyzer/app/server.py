"""Single-process entrypoint: both adapters share readiness and model capacity."""

import uvicorn
from app.config import settings


def main():
    settings.validate()
    uvicorn.run("app.main:app", host="0.0.0.0", port=8000, workers=1,
                timeout_graceful_shutdown=int(settings.SHUTDOWN_GRACE_SECONDS))


if __name__ == "__main__":
    main()
