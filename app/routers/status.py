from __future__ import annotations

from fastapi import APIRouter

from app import backend

router = APIRouter()
router.add_api_route("/api/status", backend.api_status, methods=["GET"])
