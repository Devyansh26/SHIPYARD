"""Shared fixtures: deterministic settings, async HTTP client, live DB gate.

The persistence layer is PostgreSQL (Neon) accessed through
``ContainerRepository``. Ordinary tests never contact a database -- the
repository is replaced by an in-memory double. Only the ``db``-marked tests need
a real connection, and those auto-skip unless a ``DATABASE_URL`` for the Neon
**TEST** branch is available (from the environment or ``.env``).
"""

import os
from pathlib import Path
from typing import AsyncGenerator, Optional
from urllib.parse import urlsplit

_ENV_FILE = Path(__file__).resolve().parent.parent / ".env"


def _load_env_file(path: Path) -> None:
    """Minimal ``.env`` loader: never overwrites an existing env var."""
    if not path.is_file():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip())


# Load .env *before* capturing DATABASE_URL, so a real Neon TEST-branch URL is
# picked up while a missing one can still be replaced by a harmless placeholder.
_load_env_file(_ENV_FILE)

#: The caller-provided database URL, captured before any placeholder is applied.
#: ``None`` means "no live database available" -> database tests skip.
LIVE_DATABASE_URL: Optional[str] = os.environ.get("DATABASE_URL")

# Must be set before app.config is imported (Settings fails fast if missing).
os.environ.setdefault("INTERNAL_API_KEY", "test-key-12345")
os.environ.setdefault(
    "ENCRYPTION_MASTER_KEY",
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
)
# App boot requires DATABASE_URL to exist; the placeholder is never connected to
# because tests override the repository dependency.
os.environ.setdefault("DATABASE_URL", "postgresql://cms:cms@127.0.0.1:5432/cms_test")

import pytest  # noqa: E402
import pytest_asyncio  # noqa: E402
from httpx import ASGITransport, AsyncClient  # noqa: E402

from app.config import get_settings  # noqa: E402
from app.main import create_app  # noqa: E402

get_settings.cache_clear()

#: Substrings that make a database unsafe to run tests against.
_PRODUCTION_HINTS = ("prod", "production", "live")


def _looks_like_production(url: str) -> bool:
    """True when the host or database name suggests a production database."""
    try:
        parts = urlsplit(url)
    except ValueError:
        return True  # unparseable -> refuse to touch it
    haystack = f"{parts.hostname or ''} {parts.path or ''}".lower()
    return any(hint in haystack for hint in _PRODUCTION_HINTS)


@pytest.fixture()
def anyio_backend() -> str:
    """Backend for pytest-asyncio compatibility."""
    return "asyncio"


@pytest_asyncio.fixture()
async def client() -> AsyncGenerator[AsyncClient, None]:
    """Async HTTP client bound to a fresh app instance."""
    app = create_app()
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


@pytest.fixture()
def api_key() -> str:
    """The valid internal API key for authenticated probes."""
    return get_settings().INTERNAL_API_KEY


@pytest.fixture(scope="session")
def live_database_url() -> str:
    """The Neon TEST-branch DSN, or skip the test.

    Refuses to hand out a URL whose host or database name looks like
    production -- live database tests must never touch real data.
    """
    if not LIVE_DATABASE_URL:
        pytest.skip(
            "DATABASE_URL is not set (Neon TEST branch); skipping live database test"
        )
    if _looks_like_production(LIVE_DATABASE_URL):
        pytest.skip(
            "REFUSING live database test: DATABASE_URL host/database name looks "
            "like production; use the Neon TEST branch"
        )
    return LIVE_DATABASE_URL


# ---------------------------------------------------------------------------
# Docker gate (session-scoped): real-daemon tests auto-skip when unreachable.
# ---------------------------------------------------------------------------
def _docker_is_reachable() -> bool:
    """Best-effort ping of the Docker daemon configured for the CMS."""
    try:
        import docker as docker_sdk
    except Exception:  # pragma: no cover - docker-py always installed in dev
        return False

    candidates = [{"base_url": os.environ.get("DOCKER_SOCKET")}] if os.environ.get(
        "DOCKER_SOCKET"
    ) else []
    candidates.append({})  # docker.from_env() defaults
    for kwargs in candidates:
        client = None
        try:
            client = docker_sdk.DockerClient(**kwargs)
            if client.ping():
                return True
        except Exception:
            continue
        finally:
            if client is not None:
                try:
                    client.close()
                except Exception:
                    pass
    return False


#: Cached per-process so we do not ping Docker once per test module.
_DOCKER_REACHABLE: Optional[bool] = None


@pytest.fixture(scope="session")
def docker_available() -> bool:
    """Skip Docker-dependent tests with an explicit reason when absent."""
    global _DOCKER_REACHABLE
    if _DOCKER_REACHABLE is None:
        _DOCKER_REACHABLE = _docker_is_reachable()
    if not _DOCKER_REACHABLE:
        pytest.skip(
            "SKIPPED (Docker unreachable): no Docker daemon is available at "
            "DOCKER_SOCKET or the docker-py defaults on this host."
        )
    return True


@pytest.fixture()
def real_docker_client(docker_available: bool):
    """An open docker-py client for real-daemon tests."""
    import docker as docker_sdk

    base = os.environ.get("DOCKER_SOCKET")
    client = docker_sdk.DockerClient(base_url=base) if base else docker_sdk.from_env()
    try:
        yield client
    finally:
        client.close()
