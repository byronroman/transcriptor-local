from __future__ import annotations

import sys
import types

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app import backend as _backend
from app.backend import *  # noqa: F401,F403 - temporary compatibility reexports
from app.routers import jobs, packages, pages, proofread, projects, status


def create_app() -> FastAPI:
    application = FastAPI(title="Transcriptor Mi Cami", lifespan=_backend.lifespan)
    application.add_middleware(
        CORSMiddleware,
        allow_origins=[f"http://{_backend.HOST}:{_backend.PORT}", "http://localhost:8765"],
        allow_methods=["*"],
        allow_headers=["*"],
    )
    application.mount("/static", StaticFiles(directory=_backend.STATIC_DIR), name="static")
    for router in (pages.router, status.router, projects.router, jobs.router, proofread.router, packages.router):
        application.include_router(router)
    return application


app = create_app()


def main() -> None:
    _backend.configure_windows_event_loop_policy()

    import uvicorn

    port = _backend.find_available_port(_backend.HOST, _backend.PORT)
    url = f"http://{_backend.HOST}:{port}"
    if port != _backend.PORT:
        print(f"Puerto {_backend.PORT} ocupado. Usando {port}.")
    print(f"Abriendo Transcriptor Mi Cami en {url}")
    if _backend.os.environ.get("TRANSCRIPTOR_NO_BROWSER") != "1":
        _backend.threading.Timer(1.0, lambda: _backend.webbrowser.open(url)).start()
    uvicorn.run("app.main:app", host=_backend.HOST, port=port, reload=False, access_log=False, loop=_backend.uvicorn_loop_name())


class _MainModule(types.ModuleType):
    def __getattr__(self, name: str):
        try:
            return getattr(_backend, name)
        except AttributeError as exc:
            raise AttributeError(name) from exc

    def __setattr__(self, name: str, value):
        if hasattr(_backend, name):
            setattr(_backend, name, value)
        super().__setattr__(name, value)


sys.modules[__name__].__class__ = _MainModule


if __name__ == "__main__":
    main()
