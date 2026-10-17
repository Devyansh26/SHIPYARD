# syntax=docker/dockerfile:1
#
# ShipYard Container Management Service (CMS)
# ==========================================
#
# Security note (docs/01-architecture.md, CAUTION block): this is the ONLY
# service in ShipYard that is given the Docker socket, which grants
# root-equivalent access to the Docker host. The socket is mounted at
# *runtime* by the deployment's docker-compose file -- it is NEVER baked into
# this image. This service intentionally does not ship a compose file; the
# socket mount, the read-only root filesystem (except the socket) and the
# private-network policy are the deployment's responsibility.
#
# Build:
#   docker build -t shipyard/container-management:local .
#
# Run (socket mounted by the operator/compose, never by the image):
#   docker run --rm -p 8001:8001 \
#     -v /var/run/docker.sock:/var/run/docker.sock \
#     --env-file .env \
#     shipyard/container-management:local

FROM python:3.11-slim

# No bytecode, unbuffered output, and no pip cache anywhere in the image.
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# Dependencies first: application edits don't invalidate this layer.
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Copy ONLY the runtime application. `.env`, tests and caches are excluded via
# .dockerignore -- secrets must never enter an image layer.
COPY main.py ./
COPY app ./app

# Run as an unprivileged user (docs/01: "a non-root user inside the container
# where possible"). The Docker socket is normally root:docker, so compose must
# grant this user access at runtime (e.g. `group_add: ["docker"]` or a matching
# GID); that grant is deliberately NOT part of the image.
RUN groupadd --system --gid 10001 shipyard \
    && useradd --system --uid 10001 --gid shipyard \
        --no-create-home --shell /usr/sbin/nologin shipyard \
    && chown -R shipyard:shipyard /app
USER shipyard

EXPOSE 8001

# Health probe hits the unauthenticated /health endpoint. Uses stdlib urllib so
# the slim image needs no curl/wget.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD python -c "import os,urllib.request;urllib.request.urlopen('http://127.0.0.1:'+os.environ.get('PORT','8001')+'/health',timeout=3).read()" || exit 1

# uvicorn on the configured PORT (default 8001). `exec` keeps uvicorn as PID 1
# so it receives SIGTERM directly and shuts down gracefully.
CMD exec uvicorn main:app --host "${HOST:-0.0.0.0}" --port "${PORT:-8001}"
