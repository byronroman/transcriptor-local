from __future__ import annotations

from fastapi import APIRouter

from app import backend

router = APIRouter()
router.add_api_route("/", backend.index, methods=["GET"])
