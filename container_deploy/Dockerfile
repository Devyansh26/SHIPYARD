# The deployer as a container: it still drives the *host* Docker daemon through
# the bind-mounted /var/run/docker.sock, so workloads it deploys are siblings on
# the host, not children of this container.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PORT=8002 \
    HOST=0.0.0.0 \
    WORKSPACE_DIR=/tmp/shipyard-workspaces

# git        -> `git clone --depth 1` of the target repository
# docker CLI -> every docker call (build/run/inspect/logs) targets the host daemon
# buildx     -> Docker 29's `docker build` is a buildx frontend
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git gnupg \
 && install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
 && chmod a+r /etc/apt/keyrings/docker.asc \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" \
      > /etc/apt/sources.list.d/docker.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends docker-ce-cli docker-buildx-plugin \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY main.py ./

VOLUME ["/tmp/shipyard-workspaces"]

EXPOSE 8002

# Reads $PORT so the probe still works when the port is overridden for a
# side-by-side test run (docker run --env PORT=18002).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "import os, urllib.request; urllib.request.urlopen('http://127.0.0.1:' + os.environ.get('PORT', '8002') + '/internal/v1/workers/health', timeout=3)"

CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8002", "--workers", "1", "--log-level", "info"]
