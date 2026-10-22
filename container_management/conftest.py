"""Test bootstrap.

Puts this directory on sys.path (the service uses flat absolute imports and is
run as `uvicorn main:app` from here) and supplies the required env vars before
`config.get_settings()` is ever called.
"""
import os
import sys
from pathlib import Path

HERE = Path(__file__).parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

# Must be set before `config` is imported, because Settings has required fields.
os.environ.setdefault("REDIS_URL", "redis://localhost:6379/0")
os.environ.setdefault("INTERNAL_API_KEY", "test-internal-key-0123456789")
os.environ.setdefault("DEPLOY_QUEUE_KEY", "deployments:queue")
os.environ.setdefault("DELETE_QUEUE_KEY", "deletions:queue")
os.environ.setdefault("ENVIRONMENT", "development")
# Keep the forward path off unless a test turns it on.
os.environ.pop("CONTROL_PLANE_URL", None)
os.environ.pop("CONTROL_PLANE_KEY", None)

import pytest  # noqa: E402
from fakeredis import FakeAsyncRedis  # noqa: E402

from backends import TcpBackend  # noqa: E402
from config import get_settings  # noqa: E402
from jobqueue import JobQueue  # noqa: E402

KEY = os.environ["INTERNAL_API_KEY"]
AUTH = {"X-Internal-Key": KEY}


@pytest.fixture
def redis():
    return FakeAsyncRedis(decode_responses=True)


@pytest.fixture
def client(redis):
    """TestClient WITHOUT the lifespan context, so the app never dials the real
    Redis; we inject a fake queue into app.state instead."""
    from fastapi.testclient import TestClient

    import main

    settings = get_settings()
    main.app.state.queue = JobQueue(TcpBackend(redis), settings)
    main.app.state.settings = settings
    return TestClient(main.app)
