from __future__ import annotations

from fastapi import APIRouter

from app import backend

router = APIRouter()
router.add_api_route("/api/import/package", backend.api_import_package, methods=["POST"])
router.add_api_route("/api/import/package/inspect", backend.api_import_package_inspect, methods=["POST"])
router.add_api_route("/api/projects/{project_id}/audio", backend.api_audio, methods=["GET"])
router.add_api_route("/api/projects/{project_id}/export/{fmt}", backend.api_export, methods=["GET"])
