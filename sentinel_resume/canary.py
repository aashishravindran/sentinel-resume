"""Scheduled check of the live site: load the page, sign in, read /me, ask one question.

Runs as its own Lambda a few times a day, so a broken site is noticed even when nobody visits.
Signs in as a dedicated public-scope user whose password scripts/canary_user.py rotates on every
deploy. A failed check raises, and the Lambda error alarm emails the admin.
"""

import json
import logging
import os
import time
import urllib.error
import urllib.request
from typing import Any

import boto3

from sentinel_resume.metrics import emit

logger = logging.getLogger("sentinel_resume")
logger.setLevel(logging.INFO)

CANARY_EMAIL = "canary@example.com"
PASSWORD_PARAM = "/sentinel-resume/canary-password"
QUESTION = "Where did Aashish study?"


class CanaryFailed(Exception):
    pass


def _fetch(url: str, token: str = "", body: Any = None) -> tuple[int, bytes]:
    headers = {"content-type": "application/json"}
    if token:
        headers["authorization"] = f"Bearer {token}"
    request = urllib.request.Request(
        url, data=json.dumps(body).encode() if body is not None else None, headers=headers
    )
    try:
        with urllib.request.urlopen(request, timeout=29) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read()


def check(label: str, ok: bool, detail: Any = "") -> None:
    if not ok:
        raise CanaryFailed(f"{label}: {str(detail)[:300]}")


def run(site: str, client_id: str, password: str, cognito: Any) -> dict[str, Any]:
    status, page = _fetch(site)
    check("site loads", status == 200 and b'id="root"' in page, status)

    auth = cognito.initiate_auth(
        ClientId=client_id,
        AuthFlow="USER_PASSWORD_AUTH",
        AuthParameters={"USERNAME": CANARY_EMAIL, "PASSWORD": password},
    )
    token = auth["AuthenticationResult"]["AccessToken"]

    status, raw = _fetch(f"{site}/api/me", token)
    me = json.loads(raw or b"{}")
    check("/me shows public scope", status == 200 and me.get("scope") == ["public"], raw)

    started = time.monotonic()
    status, raw = _fetch(f"{site}/api/chat", token, {"question": QUESTION})
    reply = json.loads(raw or b"{}")
    check("question is answered", status == 200 and reply.get("citations"), raw)
    return {"chat_ms": round((time.monotonic() - started) * 1000), "citations": reply["citations"]}


def handler(_event: dict[str, Any], _context: Any) -> dict[str, Any]:
    region = os.environ.get("AWS_REGION", "us-east-1")
    ssm: Any = boto3.client("ssm", region_name=region)
    password = ssm.get_parameter(Name=PASSWORD_PARAM)["Parameter"]["Value"]
    try:
        result = run(
            os.environ["SITE_URL"],
            os.environ["USER_POOL_CLIENT_ID"],
            password,
            boto3.client("cognito-idp", region_name=region),
        )
    except Exception:
        logger.exception("canary failed")
        raise
    logger.info("canary", extra={"canary": result})
    emit(CanaryPassed=1)
    return result
