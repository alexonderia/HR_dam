FROM python:3.12-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends libreoffice-writer \
    && rm -rf /var/lib/apt/lists/*
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 TZ=Europe/Moscow PORT=8002
WORKDIR /app
COPY apps/resume-evaluator/requirements.txt /tmp/requirements.txt
RUN --mount=type=cache,target=/root/.cache/pip pip install -r /tmp/requirements.txt
RUN useradd --create-home processor
COPY --chown=processor:processor packages/processing-python/src/ ./
COPY --chown=processor:processor packages/resume-documents/src/ ./
COPY --chown=processor:processor apps/resume-evaluator/src/ ./
USER processor
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=6 \
    CMD python -c "import os,urllib.request; urllib.request.urlopen('http://127.0.0.1:'+os.environ['PORT']+'/live',timeout=3)"
CMD ["python", "-m", "resume_evaluator"]
