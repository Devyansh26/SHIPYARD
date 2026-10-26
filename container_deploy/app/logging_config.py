import logging
import sys

# Same shape as uvicorn's default console format, so a `docker logs` /
# `journalctl` tail reads uniformly whether a line came from uvicorn or app.*.
LOG_FORMAT = "%(asctime)s %(levelname)-8s %(name)s: %(message)s"

_HANDLER_MARKER = "_shipyard_handler"


def configure_logging(level: str | int | None = None) -> None:
    """Attach a stdout handler to the root logger.

    uvicorn configures only its own loggers (`uvicorn`, `uvicorn.error`,
    `uvicorn.access`). Everything under `app.*` propagates to the root logger,
    which has no handlers, so Python's `logging.lastResort` handler swallows
    it below WARNING. That is why worker lines such as "Starting execution of
    deployment dep_x" never showed up in `journalctl --user -u
    container-deployer` even though the job ran.

    Idempotent: calling it again (lifespan + __main__, or tests) reuses the
    existing handler instead of duplicating every line.
    """
    if level is None:
        # Imported lazily so this module stays importable without a .env.
        from app.config import get_settings

        level = get_settings().LOG_LEVEL

    numeric_level = logging.getLevelName(str(level).strip().upper())
    if not isinstance(numeric_level, int):
        numeric_level = logging.INFO

    root = logging.getLogger()
    root.setLevel(numeric_level)

    for handler in root.handlers:
        if getattr(handler, _HANDLER_MARKER, False):
            handler.setLevel(numeric_level)
            return

    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(logging.Formatter(LOG_FORMAT))
    handler.setLevel(numeric_level)
    setattr(handler, _HANDLER_MARKER, True)
    root.addHandler(handler)
