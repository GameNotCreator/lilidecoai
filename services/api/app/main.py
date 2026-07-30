from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .config import get_settings
from .database import SessionLocal, init_db
from .purge import purge_expired_scenes
from .routes import billing, products, renders, scenes, widgets
from .security import InMemoryRateLimiter
from .seed import seed_demo
from .storage import verify_storage_signature

settings = get_settings()
rate_limiter = InMemoryRateLimiter()


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    init_db()
    with SessionLocal() as db:
        if settings.demo_mode:
            seed_demo(db, settings)
        purge_expired_scenes(db, settings)
    yield


app = FastAPI(
    title="Project Visualizer API",
    version="0.1.0",
    description=(
        "API multi-tenant de visualisation décorative. Le mode démonstration fonctionne "
        "sans service externe et n'effectue aucun appel OpenAI."
    ),
    lifespan=lifespan,
    docs_url="/docs",
    redoc_url="/redoc",
    openapi_url="/openapi.json",
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins,
    allow_credentials=False,
    allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=[
        "Authorization",
        "Content-Type",
        "Idempotency-Key",
        "X-Organization-Id",
        "X-User-Id",
        "X-User-Role",
        "X-Konnect-Signature",
    ],
)


@app.middleware("http")
async def security_headers(request: Request, call_next: object) -> object:
    if request.url.path not in {"/health", "/openapi.json"}:
        rate_limiter.check(request)
    response = await call_next(request)  # type: ignore[operator]
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "SAMEORIGIN"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    response.headers["Cache-Control"] = (
        "public, max-age=31536000, immutable"
        if request.url.path.startswith("/storage/demo/")
        else "no-store"
    )
    return response


@app.exception_handler(RuntimeError)
async def runtime_error(_: Request, exc: RuntimeError) -> JSONResponse:
    return JSONResponse(status_code=500, content={"detail": str(exc)})


@app.get("/health", tags=["system"])
def health() -> dict[str, object]:
    return {
        "status": "ok",
        "mode": "demo" if settings.demo_mode else "production",
        "imageProvider": "openai" if settings.use_openai else "mock",
        "openaiConfigured": bool(settings.openai_api_key),
    }


app.include_router(products.router, prefix=settings.api_prefix)
app.include_router(scenes.router, prefix=settings.api_prefix)
app.include_router(renders.router, prefix=settings.api_prefix)
app.include_router(billing.router, prefix=settings.api_prefix)
app.include_router(widgets.router, prefix=settings.api_prefix)
if settings.demo_mode:
    app.mount("/storage", StaticFiles(directory=settings.storage_path), name="storage")
else:

    @app.get("/storage/{asset_path:path}", include_in_schema=False)
    def private_storage(
        asset_path: str,
        expires: int = Query(),
        signature: str = Query(),
    ) -> FileResponse:
        if not verify_storage_signature(asset_path, expires, signature, settings):
            raise HTTPException(status_code=403, detail="Invalid or expired asset URL")
        candidate = (settings.storage_path / asset_path).resolve()
        storage_root = settings.storage_path.resolve()
        if storage_root not in candidate.parents or not candidate.is_file():
            raise HTTPException(status_code=404, detail="Asset not found")
        return FileResponse(candidate)
