# syntax=docker/dockerfile:1

FROM python:3.13-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    PYTHONPATH=/app \
    PVWEB_DATA_ROOT=/var/lib/pvweb

WORKDIR /app/backend

COPY backend/requirements.txt ./requirements.txt
RUN python -m pip install --upgrade pip \
    && python -m pip install --requirement requirements.txt

# Keep the repository layout expected by app.worker.  The worker adapter is
# present, but ParaView/pvpython itself is deliberately not bundled.
COPY backend/app ./app
COPY backend/alembic ./alembic
COPY backend/alembic.ini ./alembic.ini
COPY workers /app/workers

RUN addgroup --system --gid 10001 pvweb \
    && adduser --system --uid 10001 --ingroup pvweb --home /nonexistent pvweb \
    && mkdir -p /var/lib/pvweb \
    && chown -R pvweb:pvweb /var/lib/pvweb

USER pvweb

EXPOSE 8000

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=6 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=2)"]

STOPSIGNAL SIGTERM

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips=*"]
