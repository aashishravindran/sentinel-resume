"""Cognito triggers: cap daily sign-ups, and give each confirmed recruiter the default scope."""

import os
from typing import Any

import boto3

from sentinel_resume.identity import IdentityStore
from sentinel_resume.metrics import emit
from sentinel_resume.ratelimit import RateLimited, RateLimiter

DAY = 86400


def _table(env_key: str) -> Any:
    ddb: Any = boto3.resource("dynamodb")
    return ddb.Table(os.environ[env_key])


def pre_sign_up(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    limit = int(os.environ.get("SIGNUPS_PER_DAY", "50"))
    try:
        RateLimiter(_table("RATELIMIT_TABLE")).hit("global#signup", limit, DAY)
    except RateLimited:
        emit(SignUpsBlocked=1)
        # Cognito shows this message to the person signing up.
        raise Exception("Sign-ups are paused for today. Please try again tomorrow.") from None
    return event


def post_confirmation(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    if event.get("triggerSource") == "PostConfirmation_ConfirmSignUp":
        attributes = event["request"]["userAttributes"]
        IdentityStore(_table("IDENTITY_TABLE")).ensure_user(
            attributes["sub"], attributes.get("email", "")
        )
        emit(SignUps=1)
    return event
