"""Low-level Docker Engine wrapper built on ``docker-py``.

This module is the **only** place in the Container Management Service that
talks to the Docker daemon. It has three responsibilities:

1. Encapsulate every direct ``docker`` SDK interaction.
2. Translate raw ``docker.errors`` into strongly typed domain exceptions.
3. Enforce the ShipYard container sandbox (resource limits, fixed network,
   ``no-new-privileges``, ownership labels, optional healthcheck).

Every method here is synchronous/blocking on purpose. Async offloading
(``run_in_threadpool``) lives in ``ContainerService`` (Phase 4) so the event
loop is never blocked and Docker access stays isolated to this class.

Environment *values* are never logged (see module docstrings and
``create_and_run``); only non-sensitive metadata such as the image tag and the
number of env entries is emitted.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Mapping, Optional, Sequence

import docker
from docker.errors import APIError, DockerException, ImageNotFound, NotFound

logger = logging.getLogger(__name__)

__all__ = [
    "ContainerAlreadyRunningException",
    "ContainerNotFoundException",
    "DockerService",
    "DockerServiceException",
    "ImageNotFoundException",
]

#: CFS period used together with ``cpu_quota`` (100000 == 1 CPU).
_CPU_PERIOD: int = 100_000

#: Docker expresses healthcheck durations in nanoseconds.
_NANOSECONDS_PER_SECOND: int = 1_000_000_000

#: Restart on failure, bounded to avoid crash-looping forever.
_RESTART_POLICY: Dict[str, Any] = {"Name": "on-failure", "MaximumRetryCount": 5}

#: Prevents privilege escalation inside the container.
_SECURITY_OPT: List[str] = ["no-new-privileges:true"]


# ---------------------------------------------------------------------------
# Domain exceptions
# ---------------------------------------------------------------------------
class DockerServiceException(Exception):
    """Base exception for any failure while interacting with Docker."""


class ContainerNotFoundException(DockerServiceException):
    """The requested container does not exist on the Docker daemon."""


class ImageNotFoundException(DockerServiceException):
    """The requested image is not present locally and could not be used."""


class ContainerAlreadyRunningException(DockerServiceException):
    """An operation required the container to be stopped, but it was running."""


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _first_value(config: Mapping[str, Any], *keys: str) -> Any:
    """Return the first present, non-``None`` value among ``keys``."""
    for key in keys:
        if key in config and config[key] is not None:
            return config[key]
    return None


def _status_code(exc: Exception) -> Optional[int]:
    """Best-effort extraction of an HTTP status code from a docker APIError."""
    response = getattr(exc, "response", None)
    return getattr(response, "status_code", None)


def _redact_secrets(text: str, secrets: Optional[Mapping[str, str]]) -> str:
    """Replace any known secret *value* in ``text`` with ``***``.

    Defence in depth: a Docker daemon error message must never become the route
    by which an environment value reaches our logs. Values shorter than four
    characters are skipped so redaction cannot mangle ordinary words.
    """
    redacted = text
    for value in (secrets or {}).values():
        if isinstance(value, str) and len(value) >= 4:
            redacted = redacted.replace(value, "***")
    return redacted


def _build_healthcheck(config: Mapping[str, Any]) -> Dict[str, Any]:
    """Translate a ShipYard health-check config into a Docker healthcheck.

    Accepts both snake_case (``interval_seconds``) and camelCase
    (``intervalSeconds``) keys so it works with either the Pydantic field
    names or the JSON aliases. Durations are converted to nanoseconds, which
    is what the Docker API (and docker-py) expects.

    Args:
        config: Mapping with ``path``/``port`` plus optional interval,
            timeout, retries and start-period values.

    Returns:
        A dict suitable for docker-py's ``healthcheck=`` run parameter.
    """
    test = _first_value(config, "test", "Test")
    if test is None:
        path = _first_value(config, "path", "Path") or "/health"
        port = _first_value(config, "port", "Port")
        url = f"http://localhost:{port}{path}" if port else f"http://localhost{path}"
        # ``CMD-SHELL`` runs via /bin/sh so it works without a JSON exec array.
        test = ["CMD-SHELL", f"curl -fsS {url} || exit 1"]
    elif isinstance(test, str):
        test = ["CMD-SHELL", test]
    else:
        test = [str(part) for part in test]

    interval = _first_value(config, "interval_seconds", "intervalSeconds", "interval")
    timeout = _first_value(config, "timeout_seconds", "timeoutSeconds", "timeout")
    retries = _first_value(config, "retries", "Retries")
    start_period = _first_value(
        config, "start_period_seconds", "startPeriodSeconds", "start_period"
    )

    healthcheck: Dict[str, Any] = {
        "test": test,
        "interval": int(
            float(interval if interval is not None else 10) * _NANOSECONDS_PER_SECOND
        ),
        "timeout": int(
            float(timeout if timeout is not None else 5) * _NANOSECONDS_PER_SECOND
        ),
        "retries": int(retries if retries is not None else 3),
    }
    if start_period is not None:
        healthcheck["start_period"] = int(
            float(start_period) * _NANOSECONDS_PER_SECOND
        )
    return healthcheck


def _build_port_bindings(
    ports: Optional[Sequence[Mapping[str, Any]]],
) -> Dict[str, Any]:
    """Convert ShipYard port mappings into docker-py ``ports=`` bindings.

    Unbound host ports map to ``None``, letting Docker choose an ephemeral
    port. Protocol defaults to ``tcp`` and is normalised to lower case.
    """
    bindings: Dict[str, Any] = {}
    for port in ports or []:
        container_port = port.get("container_port")
        if container_port is None:
            continue
        protocol = str(port.get("protocol") or "tcp").lower()
        bindings[f"{container_port}/{protocol}"] = port.get("host_port")
    return bindings


# ---------------------------------------------------------------------------
# Service
# ---------------------------------------------------------------------------
class DockerService:
    """Thin, synchronous wrapper around a ``docker.DockerClient``.

    The constructor does not connect at import time; connection failures
    surface as :class:`DockerServiceException` so callers (the app lifespan)
    can decide whether to abort or boot degraded.

    Args:
        base_url: Docker daemon URL, e.g. ``unix:///var/run/docker.sock``.
        default_network: Network every managed container is attached to.
        client: Optional pre-built client (used by tests to inject a mock).
    """

    def __init__(
        self,
        base_url: str = "unix:///var/run/docker.sock",
        default_network: str = "shipyard_network",
        client: Optional[Any] = None,
    ) -> None:
        self.default_network = default_network
        if client is not None:
            self.client = client
            return
        try:
            self.client = docker.DockerClient(base_url=base_url)
        except DockerException as exc:  # pragma: no cover - needs a real daemon
            logger.error("Failed to initialize Docker client: %s", exc)
            raise DockerServiceException(
                f"Docker daemon connection failed: {exc}"
            ) from exc

    # -- error translation --------------------------------------------------
    def _translate_error(
        self, exc: Exception, action: str, container_id: str
    ) -> DockerServiceException:
        """Map a raw docker exception to a typed domain exception."""
        if isinstance(exc, NotFound):
            return ContainerNotFoundException(
                f"Container {container_id} not found."
            )
        if isinstance(exc, ImageNotFound):
            return ImageNotFoundException("Requested image could not be found.")
        # APIError is a DockerException; avoid logging the full (possibly
        # sensitive) payload, only its string form.
        return DockerServiceException(
            f"Docker {action} failed for {container_id}: {exc}"
        )

    # -- lifecycle ----------------------------------------------------------
    def ping(self) -> bool:
        """Return ``True`` when the Docker daemon is reachable.

        Never raises: this is used by readiness probes, which need a boolean.
        Catches broadly because a missing socket surfaces as a
        ``requests``-level connection error rather than a ``DockerException``.
        """
        try:
            self.client.ping()
            return True
        except Exception as exc:  # noqa: BLE001 - readiness probe must not raise
            logger.warning("Docker ping failed: %s", exc)
            return False

    def _ensure_network(self, network: str) -> None:
        """Create ``network`` if absent. Never removes an existing network."""
        if not network:
            return
        try:
            self.client.networks.get(network)
            return
        except NotFound:
            logger.info("Docker network '%s' not found; creating it.", network)
        except DockerException as exc:
            raise DockerServiceException(
                f"Failed to inspect Docker network '{network}': {exc}"
            ) from exc

        try:
            self.client.networks.create(network, driver="bridge")
        except APIError as exc:
            raise DockerServiceException(
                f"Failed to create Docker network '{network}': {exc}"
            ) from exc

    def create_and_run(
        self,
        name: str,
        image: str,
        ports: Sequence[Mapping[str, Any]],
        cpu_quota: int,
        memory_bytes: int,
        env: Mapping[str, str],
        labels: Mapping[str, str],
        network: str,
        healthcheck: Optional[Mapping[str, Any]] = None,
    ) -> str:
        """Create and start a detached, sandboxed container.

        Args:
            name: Container name (e.g. ``shipyard-cnt_a1b2c3``).
            image: Image reference/tag to run.
            ports: ShipYard port mappings (see :func:`_build_port_bindings`).
            cpu_quota: CFS quota; ``100000`` equals one CPU.
            memory_bytes: Memory limit in bytes (also applied to swap).
            env: Resolved environment variables. Values are never logged.
            labels: Ownership labels for reconciliation.
            network: Docker network to attach the container to.
            healthcheck: Optional ShipYard healthcheck config.

        Returns:
            The 64-character Docker container ID.

        Raises:
            ImageNotFoundException: The image is missing/unsupported.
            DockerServiceException: The daemon refused the run request.
        """
        self._ensure_network(network)
        port_bindings = _build_port_bindings(ports)

        run_kwargs: Dict[str, Any] = {
            "image": image,
            "name": name,
            "detach": True,
            "environment": dict(env) if env else None,
            "ports": port_bindings or None,
            "cpu_quota": cpu_quota,
            "cpu_period": _CPU_PERIOD,
            # memswap_limit == mem_limit disables swap amplification.
            "mem_limit": memory_bytes,
            "memswap_limit": memory_bytes,
            "restart_policy": dict(_RESTART_POLICY),
            "network": network,
            "labels": dict(labels or {}),
            "security_opt": list(_SECURITY_OPT),
        }
        if healthcheck:
            run_kwargs["healthcheck"] = _build_healthcheck(healthcheck)

        # Log only non-sensitive metadata: never env keys/values.
        logger.info(
            "Starting container name=%s image=%s network=%s env_entries=%d",
            name,
            image,
            network,
            len(env or {}),
        )

        try:
            container = self.client.containers.run(**run_kwargs)
        except ImageNotFound as exc:
            raise ImageNotFoundException(
                f"Image '{image}' not found or could not be used."
            ) from exc
        except (APIError, DockerException) as exc:
            # The daemon's text is kept for operators but scrubbed of any env
            # value first: it is logged by the error handler downstream.
            raise DockerServiceException(
                _redact_secrets(
                    f"Failed to run container from image '{image}': {exc}", env
                )
            ) from exc
        return container.id

    def get_container(self, docker_id: str) -> Any:
        """Return the docker-py container handle for ``docker_id``.

        Raises:
            ContainerNotFoundException: The daemon has no such container.
            DockerServiceException: Any other daemon error.
        """
        try:
            return self.client.containers.get(docker_id)
        except DockerException as exc:
            raise self._translate_error(exc, "get", docker_id) from exc

    def start(self, docker_id: str) -> None:
        """Start a stopped container.

        Raises:
            ContainerAlreadyRunningException: The container is already running.
        """
        container = self.get_container(docker_id)
        try:
            container.reload()
            status = container.attrs.get("State", {}).get("Status")
            if status == "running":
                raise ContainerAlreadyRunningException(
                    f"Container {docker_id} is already running."
                )
            container.start()
        except ContainerAlreadyRunningException:
            raise
        except DockerException as exc:
            # Docker returns 304 Not Modified when starting a running container.
            if _status_code(exc) == 304:
                raise ContainerAlreadyRunningException(
                    f"Container {docker_id} is already running."
                ) from exc
            raise self._translate_error(exc, "start", docker_id) from exc

    def stop(self, docker_id: str, timeout: int = 10) -> None:
        """Stop a container (SIGTERM, then SIGKILL after ``timeout`` seconds)."""
        container = self.get_container(docker_id)
        try:
            container.stop(timeout=timeout)
        except DockerException as exc:
            raise self._translate_error(exc, "stop", docker_id) from exc

    def restart(self, docker_id: str, timeout: int = 10) -> None:
        """Restart a container."""
        container = self.get_container(docker_id)
        try:
            container.restart(timeout=timeout)
        except DockerException as exc:
            raise self._translate_error(exc, "restart", docker_id) from exc

    def remove(self, docker_id: str, force: bool = False) -> None:
        """Remove a container. ``force=True`` kills it if still running."""
        container = self.get_container(docker_id)
        try:
            container.remove(force=force)
        except DockerException as exc:
            raise self._translate_error(exc, "remove", docker_id) from exc

    # -- inspection ---------------------------------------------------------
    def get_logs(self, docker_id: str, tail: int = 500) -> str:
        """Return merged stdout/stderr logs (last ``tail`` lines)."""
        container = self.get_container(docker_id)
        try:
            raw = container.logs(
                stdout=True, stderr=True, tail=tail, timestamps=True
            )
        except DockerException as exc:
            raise self._translate_error(exc, "logs", docker_id) from exc
        if isinstance(raw, bytes):
            return raw.decode("utf-8", errors="replace")
        return str(raw)

    def get_stats(self, docker_id: str) -> Dict[str, Any]:
        """Read a single (non-streamed) stats sample from the daemon."""
        container = self.get_container(docker_id)
        try:
            return container.stats(stream=False)
        except DockerException as exc:
            raise self._translate_error(exc, "stats", docker_id) from exc

    def get_health(self, docker_id: str) -> Dict[str, Any]:
        """Return the container's Docker health block.

        Falls back to ``{"Status": "none"}`` when no healthcheck is defined.
        """
        container = self.get_container(docker_id)
        try:
            container.reload()
        except DockerException as exc:
            raise self._translate_error(exc, "health", docker_id) from exc
        state = container.attrs.get("State", {}) or {}
        return state.get("Health") or {"Status": "none"}

    # -- teardown -----------------------------------------------------------
    def close(self) -> None:
        """Close the underlying Docker client (best effort)."""
        try:
            self.client.close()
        except Exception as exc:  # pragma: no cover - defensive
            logger.warning("Error closing Docker client: %s", exc)
