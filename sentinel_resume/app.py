"""HTTP API handlers. One bundle; chat runs as its own function with its own concurrency."""

import asyncio
import base64
import json
import logging
import re
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

import boto3
from sentinel_engine.engine import SentinelEngine
from sentinel_engine.errors import AccessDeniedError, IdentityError
from sentinel_engine.filters import authorize_chunks
from sentinel_engine.oidc import OIDCSettings, TokenVerifier
from sentinel_engine.principal import Principal
from sentinel_engine.results import NO_RELEVANT_ACCESS, filter_relevant

from sentinel_resume.audit import AuditLog
from sentinel_resume.auth import AdminGate, NotAdmin, authenticate
from sentinel_resume.catalog import Doc, load_catalog, requestable_tags
from sentinel_resume.config import Settings
from sentinel_resume.identity import ExpiringDdbIdentity, IdentityStore
from sentinel_resume.knowledge import S3VectorsKnowledge, TitanEmbedder, build_filter
from sentinel_resume.library import load_index
from sentinel_resume.llm import BedrockChatModel, ChatModel, answer, cited_titles
from sentinel_resume.ratelimit import RateLimited, RateLimiter
from sentinel_resume.requests_store import DuplicateRequest, RequestNotPending, RequestsStore

logger = logging.getLogger("sentinel_resume")
logger.setLevel(logging.INFO)

HOUR, DAY = 3600, 86400
MAX_GRANT_MINUTES = 30 * 24 * 60
DEFAULT_GRANT_MINUTES = 7 * 24 * 60
REQUEST_HINT = " You can request restricted documents on the Documents page."
RESTING = "The demo has hit its daily budget and is resting. Please come back tomorrow."


class HttpError(Exception):
    def __init__(self, status: int, message: str, headers: dict[str, str] | None = None):
        super().__init__(message)
        self.status = status
        self.headers = headers or {}


@dataclass
class Services:
    settings: Settings
    verifier: TokenVerifier
    engine: SentinelEngine
    knowledge: S3VectorsKnowledge
    identity: IdentityStore
    requests: RequestsStore
    limiter: RateLimiter
    audit: AuditLog
    admin: AdminGate
    model: ChatModel
    catalog: list[Doc]
    ses: Any

    @classmethod
    def from_env(cls) -> "Services":
        settings = Settings.from_env()
        ddb: Any = boto3.resource("dynamodb", region_name=settings.region)
        bedrock = boto3.client("bedrock-runtime", region_name=settings.region)
        identity = IdentityStore(ddb.Table(settings.identity_table))
        knowledge = S3VectorsKnowledge(
            boto3.client("s3vectors", region_name=settings.region),
            settings.vector_bucket,
            settings.vector_index,
            TitanEmbedder(bedrock, settings.embed_model_id),
        )
        engine = SentinelEngine(ExpiringDdbIdentity(identity), knowledge)
        return cls(
            settings=settings,
            verifier=TokenVerifier(OIDCSettings.from_env()),
            engine=engine,
            knowledge=knowledge,
            identity=identity,
            requests=RequestsStore(ddb.Table(settings.requests_table)),
            limiter=RateLimiter(ddb.Table(settings.ratelimit_table)),
            audit=AuditLog(ddb.Table(settings.audit_table)),
            admin=AdminGate(
                engine,
                boto3.client("ssm", region_name=settings.region),
                boto3.client("cognito-idp", region_name=settings.region),
                settings.admin_subs_param,
                settings.user_pool_id,
                settings.require_admin_mfa,
            ),
            model=BedrockChatModel(bedrock, settings.chat_model_id),
            catalog=load_catalog(),
            ses=boto3.client("sesv2", region_name=settings.region),
        )


Handler = Callable[[Services, Principal, dict[str, Any]], Awaitable[Any]]


def _body(event: dict[str, Any]) -> dict[str, Any]:
    raw = event.get("body") or "{}"
    if event.get("isBase64Encoded"):
        raw = base64.b64decode(raw).decode()
    try:
        body = json.loads(raw)
    except json.JSONDecodeError:
        raise HttpError(400, "body must be JSON") from None
    if not isinstance(body, dict):
        raise HttpError(400, "body must be a JSON object")
    return body


def _email(principal: Principal, services: Services) -> str:
    # Access tokens carry no email; the identity item stores it from sign-up.
    return str(services.identity.item(principal.user_id).get("email", ""))


# --- recruiter routes -------------------------------------------------------------------------


async def me(s: Services, p: Principal, _: dict[str, Any]) -> Any:
    item = s.identity.item(p.user_id)
    admin = await s.admin.status(p)
    return {
        "user_id": p.user_id,
        "email": item.get("email", ""),
        "scope": sorted(s.identity.tags(p.user_id) - {"sentinel_admin"}),
        "grants": s.identity.grants(p.user_id),
        "is_admin": admin == "admin",
        # Named admin without TOTP: show the admin link so they can set it up there.
        "admin_needs_mfa": admin == "needs_mfa",
        "pending_requests": len(s.requests.by_status("pending")) if admin == "admin" else 0,
    }


async def catalog(s: Services, p: Principal, _: dict[str, Any]) -> Any:
    scope = s.identity.tags(p.user_id)
    tags = list(requestable_tags(s.catalog))
    requests = {r["tag"]: r for r in s.requests.for_user(p.user_id, tags)}
    return {
        "documents": [
            {
                "doc_id": d.doc_id,
                "title": d.title,
                "description": d.description,
                "tag": d.tag,
                "requestable": d.requestable,
                "has_access": d.tag in scope,
                "request": _public_request(requests.get(d.tag)),
            }
            for d in s.catalog
        ],
        # Public design docs: everyone can read these, so listing them reveals nothing.
        "library": load_index(),
    }


def _public_request(item: dict[str, Any] | None) -> dict[str, Any] | None:
    if not item:
        return None
    keys = ("request_id", "tag", "status", "reason", "created_at", "decided_at", "expires_at")
    return {k: item[k] for k in keys if k in item}


_ABOUT_THIS_SITE = re.compile(
    r"\b(here|this (site|app|assistant|chat(bot)?|demo|page)|how (do|does) you work)\b", re.I
)


def search_query(question: str) -> str:
    """The text embedded for search. "How do you work?" says nothing about which project it means;
    naming this one keeps other projects' architecture docs from outranking it."""
    if _ABOUT_THIS_SITE.search(question):
        return f"{question} (Resume assistant, sentinel-resume)"
    return question


async def chat(s: Services, p: Principal, event: dict[str, Any]) -> Any:
    question = str(_body(event).get("question", "")).strip()
    limits = s.settings.limits
    if not question:
        raise HttpError(400, "question is required")
    if len(question) > limits.max_query_chars:
        raise HttpError(400, f"question is longer than {limits.max_query_chars} characters")
    s.limiter.hit(f"{p.user_id}#chat", limits.chat_per_hour, HOUR)
    s.limiter.hit(f"{p.user_id}#chat", limits.chat_per_day, DAY)

    # SentinelEngine.secure_search, step by step, so the page can show each layer's work.
    scope = await s.engine.resolve_scope(p.user_id)
    retrieved = await s.knowledge.search(search_query(question), scope, limits.n_results)
    authorized = authorize_chunks(retrieved, scope)
    relevant = filter_relevant(authorized, s.settings.min_relevance)
    trace = {
        "scope": sorted(scope),
        "filter": build_filter(scope),
        "retrieved": len(retrieved),
        "dropped_by_postcheck": len(retrieved) - len(authorized),
        "below_relevance": len(authorized) - len(relevant),
        "chunks": [
            {"title": c["metadata"].get("title", ""), "score": c["score"]} for c in relevant
        ],
    }
    logger.info(json.dumps({"chat": {"user": p.user_id, **trace, "chunks": len(relevant)}}))
    no_answer = {
        "answer": NO_RELEVANT_ACCESS + REQUEST_HINT,
        "answered": False,
        "citations": [],
        "trace": trace,
    }
    if not relevant:
        return no_answer

    try:
        s.limiter.hit("global#bedrock", limits.global_chat_per_day, DAY)
    except RateLimited:
        raise HttpError(503, RESTING) from None
    text = await asyncio.to_thread(answer, s.model, question, relevant)
    if text is None:
        # Same reply as finding nothing: an unanswerable question reveals nothing either way.
        return no_answer
    return {
        "answer": text,
        "answered": True,
        "citations": cited_titles(text, relevant),
        "trace": trace,
    }


async def my_requests(s: Services, p: Principal, _: dict[str, Any]) -> Any:
    items = s.requests.for_user(p.user_id, list(requestable_tags(s.catalog)))
    return {"requests": [_public_request(i) for i in items]}


async def create_request(s: Services, p: Principal, event: dict[str, Any]) -> Any:
    body = _body(event)
    tag, reason = str(body.get("tag", "")), str(body.get("reason", "")).strip()
    doc = requestable_tags(s.catalog).get(tag)
    if doc is None:
        raise HttpError(400, "that document cannot be requested")
    if not reason:
        raise HttpError(400, "a reason is required")
    if tag in s.identity.tags(p.user_id):
        raise HttpError(409, "you already have access to that document")
    s.limiter.hit(f"{p.user_id}#request", s.settings.limits.requests_per_day, DAY)
    email = _email(p, s)
    try:
        item = s.requests.create(p.user_id, email, tag, reason)
    except DuplicateRequest:
        raise HttpError(409, "you already have an open request for that document") from None
    s.audit.record("request", p.user_id, tag=tag, email=email)
    site = s.settings.site_url or (event.get("headers") or {}).get("origin", "")
    _notify_admin(s, email, doc, item["reason"], site)
    return {"request": _public_request(item)}


def _notify_admin(s: Services, email: str, doc: Doc, reason: str, site: str) -> None:
    if not (s.settings.admin_email and s.settings.from_email):
        return
    try:
        s.ses.send_email(
            FromEmailAddress=s.settings.from_email,
            Destination={"ToAddresses": [s.settings.admin_email]},
            Content={
                "Simple": {
                    "Subject": {"Data": f"Access request: {doc.title}"},
                    "Body": {
                        "Text": {
                            "Data": f"{email or 'A recruiter'} asked for {doc.title}.\n\n"
                            f"Reason: {reason}\n\nReview: {site}/admin"
                        }
                    },
                }
            },
        )
    except Exception:
        logger.exception("admin notification failed")


# --- admin routes -----------------------------------------------------------------------------


async def admin_overview(s: Services, p: Principal, _: dict[str, Any]) -> Any:
    return {
        "pending": s.requests.by_status("pending"),
        "decided": s.requests.by_status("approved")[:20] + s.requests.by_status("denied")[:20],
        "grants": s.identity.all_grants(),
        "audit": s.audit.recent(time.strftime("%Y-%m-%d", time.gmtime())),
    }


async def approve(s: Services, p: Principal, event: dict[str, Any]) -> Any:
    rid = _request_id(event)
    request = s.requests.get(rid)
    if not request or request["tag"] not in requestable_tags(s.catalog):
        raise HttpError(404, "no such request")
    minutes = _body(event).get("minutes", DEFAULT_GRANT_MINUTES)
    if not isinstance(minutes, int) or not 1 <= minutes <= MAX_GRANT_MINUTES:
        raise HttpError(400, f"minutes must be an integer from 1 to {MAX_GRANT_MINUTES}")
    expires_at = int(time.time()) + minutes * 60
    try:
        decided = s.requests.decide(rid, "approved", p.user_id, expires_at)
    except RequestNotPending:
        raise HttpError(409, "that request was already decided") from None
    s.identity.grant(decided["user_id"], decided["tag"], expires_at)
    s.audit.record(
        "grant", p.user_id, subject=decided["user_id"], tag=decided["tag"], expires_at=expires_at
    )
    return {"request": decided}


async def deny(s: Services, p: Principal, event: dict[str, Any]) -> Any:
    rid = _request_id(event)
    try:
        decided = s.requests.decide(rid, "denied", p.user_id, None)
    except RequestNotPending:
        raise HttpError(409, "that request was already decided") from None
    s.audit.record("deny", p.user_id, subject=decided["user_id"], tag=decided["tag"])
    return {"request": decided}


async def revoke(s: Services, p: Principal, event: dict[str, Any]) -> Any:
    body = _body(event)
    user_id, tag = str(body.get("user_id", "")), str(body.get("tag", ""))
    if tag not in requestable_tags(s.catalog):
        raise HttpError(400, "only requestable documents can be revoked here")
    try:
        s.identity.revoke(user_id, tag)
    except (IdentityError, ValueError):
        raise HttpError(400, "invalid user or tag") from None
    s.audit.record("revoke", p.user_id, subject=user_id, tag=tag)
    return {"revoked": {"user_id": user_id, "tag": tag}}


def _request_id(event: dict[str, Any]) -> str:
    rid = (event.get("pathParameters") or {}).get("id", "")
    if not rid or len(rid) > 300:
        raise HttpError(400, "request id is required")
    return rid


ROUTES: dict[str, tuple[Handler, bool]] = {
    "GET /me": (me, False),
    "GET /catalog": (catalog, False),
    "POST /chat": (chat, False),
    "GET /requests": (my_requests, False),
    "POST /requests": (create_request, False),
    "GET /admin/overview": (admin_overview, True),
    "POST /admin/requests/{id}/approve": (approve, True),
    "POST /admin/requests/{id}/deny": (deny, True),
    "POST /admin/grants/revoke": (revoke, True),
}


def _response(status: int, body: Any, headers: dict[str, str] | None = None) -> dict[str, Any]:
    return {
        "statusCode": status,
        "headers": {
            "content-type": "application/json",
            "cache-control": "no-store",
            **(headers or {}),
        },
        "body": json.dumps(body, default=_json_default),
    }


def _json_default(value: Any) -> Any:
    # DynamoDB numbers come back as Decimal; sets as set.
    if isinstance(value, set):
        return sorted(value)
    return int(value) if value == int(value) else float(value)


async def dispatch(services: Services, event: dict[str, Any]) -> dict[str, Any]:
    # CloudFront serves the API under /api on the site's own origin, so there is no CORS.
    route = ROUTES.get(event.get("routeKey", "").replace(" /api/", " /", 1))
    if route is None:
        return _response(404, {"error": "not found"})
    handler, admin_only = route
    principal: Principal | None = None
    try:
        principal = authenticate(event.get("headers") or {}, services.verifier)
        if admin_only:
            await services.admin.require(principal)
        return _response(200, await handler(services, principal, event))
    except HttpError as exc:
        return _response(exc.status, {"error": str(exc)}, exc.headers)
    except RateLimited as exc:
        return _response(
            429,
            {"error": "too many requests", "retry_after": exc.retry_after},
            {"retry-after": str(exc.retry_after)},
        )
    except NotAdmin as exc:
        actor = principal.user_id if principal else ""
        services.audit.record("admin_denied", actor, check=exc.check)
        return _response(403, {"error": "forbidden"})
    except IdentityError:
        return _response(401, {"error": "unauthorized"})
    except AccessDeniedError:
        return _response(403, {"error": "Access denied."})
    except Exception:
        logger.exception("unhandled error on %s", event.get("routeKey"))
        return _response(500, {"error": "internal error"})


_services: Services | None = None


def handler(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    global _services
    if _services is None:
        _services = Services.from_env()
    return asyncio.run(dispatch(_services, event))
