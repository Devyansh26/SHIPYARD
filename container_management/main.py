"""Root entrypoint: exposes `app` so `uvicorn main:app` works from this folder."""

from app.main import app

__all__ = ["app"]
