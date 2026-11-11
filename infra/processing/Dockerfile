FROM python:3.12-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends libreoffice-writer \
    && rm -rf /var/lib/apt/lists/*
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 TZ=Europe/Moscow
WORKDIR /app
COPY apps/resume-analyzer/requirements.txt /tmp/analyzer-requirements.txt
COPY infra/processing/requirements.txt /tmp/processing-requirements.txt
RUN --mount=type=cache,target=/root/.cache/pip pip install \
    -r /tmp/analyzer-requirements.txt -r /tmp/processing-requirements.txt
RUN useradd --create-home processor
COPY --chown=processor:processor apps/resume-analyzer/app ./app
ARG OPERATION
ENV PROCESSING_OPERATION=${OPERATION}
USER processor
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=6 \
    CMD python -c "import os,urllib.request; urllib.request.urlopen('http://127.0.0.1:'+os.environ['PORT']+'/health',timeout=3)"
CMD ["python", "-m", "app.processing_v2"]
