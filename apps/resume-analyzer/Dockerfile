FROM python:3.12-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        libreoffice-writer \
    && rm -rf /var/lib/apt/lists/*
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 TZ=Europe/Moscow
WORKDIR /app
COPY requirements.txt ./
RUN --mount=type=cache,target=/root/.cache/pip pip install -r requirements.txt
RUN useradd --create-home analyzer
COPY --chown=analyzer:analyzer app ./app
USER analyzer
EXPOSE 8000
# The entrypoint fixes Uvicorn to one worker; HTTP and AMQP share a model lock.
CMD ["python", "-m", "app.server"]
