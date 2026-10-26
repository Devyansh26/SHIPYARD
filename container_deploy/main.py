import uvicorn
from app.config import get_settings
from app.logging_config import configure_logging
from app.main import app

if __name__ == "__main__":
    settings = get_settings()
    configure_logging(settings.LOG_LEVEL)
    uvicorn.run(
        "app.main:app",
        host=settings.HOST,
        port=settings.PORT,
        reload=True
    )
