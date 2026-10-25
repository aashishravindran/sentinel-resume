"""Settings, read once per cold start from the Lambda environment."""

import os
from collections.abc import Mapping
from dataclasses import dataclass


@dataclass(frozen=True)
class Limits:
    chat_per_hour: int = 20
    chat_per_day: int = 60
    requests_per_day: int = 5
    global_chat_per_day: int = 1500
    signups_per_day: int = 50
    max_query_chars: int = 1000
    n_results: int = 6


@dataclass(frozen=True)
class Settings:
    region: str
    identity_table: str
    requests_table: str
    ratelimit_table: str
    audit_table: str
    vector_bucket: str
    vector_index: str
    chat_model_id: str
    embed_model_id: str
    user_pool_id: str
    admin_subs_param: str
    admin_email: str
    from_email: str
    site_url: str
    require_admin_mfa: bool
    min_relevance: float
    limits: Limits

    @classmethod
    def from_env(cls, env: Mapping[str, str] = os.environ) -> "Settings":
        return cls(
            region=env.get("AWS_REGION", "us-east-1"),
            identity_table=env["IDENTITY_TABLE"],
            requests_table=env["REQUESTS_TABLE"],
            ratelimit_table=env["RATELIMIT_TABLE"],
            audit_table=env["AUDIT_TABLE"],
            vector_bucket=env["VECTOR_BUCKET"],
            vector_index=env.get("VECTOR_INDEX", "resume"),
            chat_model_id=env.get("CHAT_MODEL_ID", "us.amazon.nova-lite-v1:0"),
            embed_model_id=env.get("EMBED_MODEL_ID", "amazon.titan-embed-text-v2:0"),
            user_pool_id=env["SENTINEL_OIDC_ISSUER"].rstrip("/").rsplit("/", 1)[-1],
            admin_subs_param=env.get("ADMIN_SUBS_PARAM", "/sentinel-resume/admin-subs"),
            admin_email=env.get("ADMIN_EMAIL", ""),
            from_email=env.get("FROM_EMAIL", ""),
            site_url=env.get("SITE_URL", ""),
            require_admin_mfa=env.get("REQUIRE_ADMIN_MFA", "true").lower() == "true",
            min_relevance=float(env.get("MIN_RELEVANCE_SCORE", "0.05")),
            limits=Limits(),
        )
