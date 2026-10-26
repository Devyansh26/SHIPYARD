import logging
import sys

import pytest

from app.logging_config import _HANDLER_MARKER, configure_logging


@pytest.fixture(autouse=True)
def clean_root_logger():
    """Restore the root logger so tests cannot leak handlers into each other."""
    root = logging.getLogger()
    original_level = root.level
    original_handlers = list(root.handlers)
    yield
    for handler in list(root.handlers):
        if getattr(handler, _HANDLER_MARKER, False):
            root.removeHandler(handler)
    for handler in original_handlers:
        if handler not in root.handlers:
            root.addHandler(handler)
    root.setLevel(original_level)


def _app_handlers():
    return [h for h in logging.getLogger().handlers if getattr(h, _HANDLER_MARKER, False)]


def test_info_from_app_logger_reaches_stdout(capsys):
    configure_logging("INFO")

    logging.getLogger("app.worker").info("Starting execution of deployment dep_abc")

    captured = capsys.readouterr()
    assert "Starting execution of deployment dep_abc" in captured.out


def test_level_is_applied_and_debug_is_respected(capsys):
    configure_logging("DEBUG")

    logging.getLogger("app.services.deployer_service").debug("docker build detail")

    assert logging.getLogger().level == logging.DEBUG
    assert "docker build detail" in capsys.readouterr().out


def test_warning_level_suppresses_info(capsys):
    configure_logging("WARNING")

    log = logging.getLogger("app.worker")
    log.info("this should be filtered")
    log.warning("this should be kept")

    out = capsys.readouterr().out
    assert "this should be filtered" not in out
    assert "this should be kept" in out


def test_configure_twice_does_not_duplicate_output(capsys):
    configure_logging("INFO")
    configure_logging("INFO")

    logging.getLogger("app.worker").info("single line please")

    out = capsys.readouterr().out
    assert out.count("single line please") == 1
    assert len(_app_handlers()) == 1


def test_invalid_level_falls_back_to_info():
    configure_logging("not-a-level")

    assert logging.getLogger().level == logging.INFO


def test_handler_writes_to_stdout_not_stderr():
    configure_logging("INFO")

    handler = _app_handlers()[0]
    assert handler.stream is sys.stdout
