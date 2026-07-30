from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

API_DIR = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(".env", ".env.local"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    app_name: str = "Project Visualizer API"
    environment: str = "development"
    api_prefix: str = "/v1"
    database_url: str = f"sqlite:///{(API_DIR / 'visualizer.db').as_posix()}"
    storage_path: Path = API_DIR / "storage"
    public_api_url: str = "http://127.0.0.1:8000"
    web_url: str = "http://localhost:3000"
    cors_origins: str = "http://localhost:3000,http://127.0.0.1:3000"
    max_upload_bytes: int = 12 * 1024 * 1024
    min_image_dimension: int = 320
    room_retention_hours: int = 24
    demo_mode: bool = True
    demo_organization_id: str = "00000000-0000-4000-8000-000000000001"
    demo_user_id: str = "00000000-0000-4000-8000-000000000002"
    initial_demo_credits: int = 12

    openai_api_key: str | None = None
    openai_model: str = "gpt-image-2"
    openai_quality: str = "medium"
    openai_timeout_seconds: float = 120
    openai_max_retries: int = 1
    openai_max_cost_usd: float = 0.25
    openai_base_url: str = "https://api.openai.com/v1"

    redis_url: str | None = None
    konnect_api_key: str | None = None
    konnect_webhook_secret: str | None = None
    konnect_base_url: str = "https://api.konnect.network/api/v2"
    posthog_key: str | None = None
    sentry_dsn: str | None = None
    signed_url_secret: str = Field(
        default="development-only-change-me",
        min_length=16,
    )
    signed_url_ttl_seconds: int = 900
    supabase_jwt_secret: str | None = None

    @property
    def allowed_origins(self) -> list[str]:
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]

    @property
    def is_production(self) -> bool:
        return self.environment.lower() == "production"

    @property
    def use_openai(self) -> bool:
        return bool(self.openai_api_key) and not self.demo_mode


@lru_cache
def get_settings() -> Settings:
    settings = Settings()
    settings.storage_path.mkdir(parents=True, exist_ok=True)
    if settings.is_production and settings.signed_url_secret == "development-only-change-me":
        raise RuntimeError("SIGNED_URL_SECRET must be changed in production")
    return settings
