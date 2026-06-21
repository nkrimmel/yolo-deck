from fastapi import Header, HTTPException, Query, WebSocketException, status
from .config import settings


async def verify_token(authorization: str | None = Header(None)):
    """FastAPI dependency to verify Bearer token auth."""
    if not settings.auth_token:
        return  # No auth configured
    if not authorization:
        raise HTTPException(status_code=401, detail="Authorization header required")
    parts = authorization.split(" ", 1)
    if len(parts) != 2 or parts[0].lower() != "bearer" or parts[1] != settings.auth_token:
        raise HTTPException(status_code=401, detail="Invalid token")


async def verify_ws_token(token: str | None = Query(None)):
    """Verify token for WebSocket connections."""
    if not settings.auth_token:
        return
    if token != settings.auth_token:
        raise WebSocketException(code=status.WS_1008_POLICY_VIOLATION)
