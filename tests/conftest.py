"""Services wired to fakes: moto DynamoDB, an in-memory S3 Vectors, a recording chat model."""

import asyncio
import hashlib
import json
import math
import re
import time
from pathlib import Path
from typing import Any

import boto3
import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from moto import mock_aws
from sentinel_engine.engine import SentinelEngine
from sentinel_engine.oidc import OIDCSettings, TokenVerifier

from sentinel_resume.app import Services, dispatch
from sentinel_resume.audit import AuditLog
from sentinel_resume.auth import AdminGate
from sentinel_resume.catalog import load_catalog, restricted_tags
from sentinel_resume.config import Limits, Settings
from sentinel_resume.identity import ExpiringDdbIdentity, IdentityStore
from sentinel_resume.knowledge import S3VectorsKnowledge
from sentinel_resume.ratelimit import RateLimiter
from sentinel_resume.requests_store import RequestsStore

CORPUS = Path(__file__).parent.parent / "corpus"
ISSUER = "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_TEST"
CLIENT_ID = "testclient"
RECRUITER = "11111111-aaaa-bbbb-cccc-000000000001"
ADMIN = "11111111-aaaa-bbbb-cccc-0000000000ad"


class HashEmbedder:
    """Deterministic bag-of-words vectors: similar wording gives similar vectors."""

    def embed(self, text: str) -> list[float]:
        vec = [0.0] * 256
        for word in re.findall(r"[a-z0-9]+", text.lower()):
            vec[int(hashlib.md5(word.encode()).hexdigest(), 16) % 256] += 1.0
        norm = math.sqrt(sum(v * v for v in vec)) or 1.0
        return [v / norm for v in vec]


def _matches(metadata: dict[str, Any], flt: dict[str, Any]) -> bool:
    if "$or" in flt:
        return any(_matches(metadata, f) for f in flt["$or"])
    ((key, cond),) = flt.items()
    return metadata.get(key) == cond["$eq"]


class FakeS3Vectors:
    """Evaluates the filter the way S3 Vectors does; records every query's filter."""

    def __init__(self) -> None:
        self.vectors: dict[str, dict[str, Any]] = {}
        self.filters: list[dict[str, Any]] = []
        self.ignore_filter = False

    def put_vectors(self, vectors: list[dict[str, Any]], **_: Any) -> None:
        for v in vectors:
            self.vectors[v["key"]] = v

    def delete_vectors(self, keys: list[str], **_: Any) -> None:
        for k in keys:
            self.vectors.pop(k, None)

    def query_vectors(self, **kw: Any) -> dict[str, Any]:
        self.filters.append(kw["filter"])
        q = kw["queryVector"]["float32"]
        hits = []
        for v in self.vectors.values():
            if not self.ignore_filter and not _matches(v["metadata"], kw["filter"]):
                continue
            sim = sum(a * b for a, b in zip(q, v["data"]["float32"], strict=True))
            hits.append({"key": v["key"], "metadata": dict(v["metadata"]), "distance": 1 - sim})
        hits.sort(key=lambda h: h["distance"])
        return {"vectors": hits[: kw["topK"]]}


class RecordingModel:
    def __init__(self) -> None:
        self.prompts: list[str] = []
        self.reply = "stub answer [Resume]"

    def complete(self, system: str, user: str) -> str:
        self.prompts.append(user)
        return self.reply


class FakeSSM:
    def __init__(self, value: str) -> None:
        self.value = value

    def get_parameter(self, Name: str) -> dict[str, Any]:
        return {"Parameter": {"Value": self.value}}


class FakeCognito:
    def __init__(self) -> None:
        self.mfa: set[str] = set()

    def admin_get_user(self, UserPoolId: str, Username: str) -> dict[str, Any]:
        return {"UserMFASettingList": ["SOFTWARE_TOKEN_MFA"] if Username in self.mfa else []}


class FakeSES:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    def send_email(self, **kw: Any) -> None:
        self.sent.append(kw)


def _tables() -> dict[str, Any]:
    ddb = boto3.resource("dynamodb", region_name="us-east-1")

    def table(name: str, pk: str, gsi: tuple[str, str, str] | None = None) -> Any:
        kw: dict[str, Any] = {
            "TableName": name,
            "KeySchema": [{"AttributeName": pk, "KeyType": "HASH"}],
            "AttributeDefinitions": [{"AttributeName": pk, "AttributeType": "S"}],
            "BillingMode": "PAY_PER_REQUEST",
        }
        if gsi:
            index, hash_key, range_key = gsi
            kw["AttributeDefinitions"] += [
                {"AttributeName": hash_key, "AttributeType": "S"},
                {"AttributeName": range_key, "AttributeType": "N"},
            ]
            kw["GlobalSecondaryIndexes"] = [
                {
                    "IndexName": index,
                    "KeySchema": [
                        {"AttributeName": hash_key, "KeyType": "HASH"},
                        {"AttributeName": range_key, "KeyType": "RANGE"},
                    ],
                    "Projection": {"ProjectionType": "ALL"},
                }
            ]
        return ddb.create_table(**kw)

    return {
        "identity": table("identity", "user_id"),
        "requests": table("requests", "request_id", ("by_status", "status", "created_at")),
        "ratelimit": table("ratelimit", "pk"),
        "audit": table("audit", "pk", ("by_day", "day", "at")),
    }


class Harness:
    def __init__(
        self,
        services: Services,
        vectors: FakeS3Vectors,
        model: RecordingModel,
        key: Any,
        cognito: FakeCognito,
        ssm: FakeSSM,
        ses: FakeSES,
    ):
        self.services = services
        self.vectors = vectors
        self.model = model
        self.key = key
        self.cognito = cognito
        self.ssm = ssm
        self.ses = ses

    def token(
        self,
        sub: str,
        *,
        groups: list[str] | None = None,
        token_use: str = "access",
        client_id: str = CLIENT_ID,
        exp_in: int = 3600,
        key: Any = None,
    ) -> str:
        now = int(time.time())
        claims: dict[str, Any] = {
            "sub": sub,
            "iss": ISSUER,
            "client_id": client_id,
            "token_use": token_use,
            "iat": now,
            "exp": now + exp_in,
            "username": sub,
        }
        if groups:
            claims["cognito:groups"] = groups
        return jwt.encode(claims, key or self.key, algorithm="RS256")

    def call(
        self, route: str, token: str | None, body: Any = None, path: dict[str, str] | None = None
    ) -> tuple[int, Any]:
        event: dict[str, Any] = {
            "routeKey": route,
            "headers": {"authorization": f"Bearer {token}"} if token else {},
            "body": json.dumps(body) if body is not None else None,
            "pathParameters": path,
        }
        response = asyncio.run(dispatch(self.services, event))
        return response["statusCode"], json.loads(response["body"])


def ingest_corpus(knowledge: S3VectorsKnowledge) -> None:
    for doc in load_catalog():
        text = (CORPUS / doc.file).read_text()
        asyncio.run(knowledge.ingest(text, [doc.tag], doc.doc_id, {"title": doc.title}))


@pytest.fixture
def harness() -> Any:
    with mock_aws():
        tables = _tables()
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        public_pem = (
            key.public_key()
            .public_bytes(
                serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo
            )
            .decode()
        )
        settings = Settings(
            region="us-east-1",
            identity_table="identity",
            requests_table="requests",
            ratelimit_table="ratelimit",
            audit_table="audit",
            vector_bucket="b",
            vector_index="resume",
            chat_model_id="m",
            embed_model_id="e",
            user_pool_id="us-east-1_TEST",
            admin_subs_param="/p",
            admin_email="me@example.com",
            from_email="me@example.com",
            site_url="https://site",
            require_admin_mfa=True,
            min_relevance=0.0,
            limits=Limits(chat_per_hour=5, chat_per_day=8, requests_per_day=3),
        )
        identity = IdentityStore(tables["identity"])
        vectors, model = FakeS3Vectors(), RecordingModel()
        knowledge = S3VectorsKnowledge(vectors, "b", "resume", HashEmbedder())
        engine = SentinelEngine(ExpiringDdbIdentity(identity), knowledge)
        cognito, ssm, ses = FakeCognito(), FakeSSM(ADMIN), FakeSES()
        catalog = load_catalog()
        services = Services(
            settings=settings,
            verifier=TokenVerifier(
                OIDCSettings(issuer=ISSUER, public_key=public_pem, allowed_clients=(CLIENT_ID,))
            ),
            engine=engine,
            knowledge=knowledge,
            identity=identity,
            requests=RequestsStore(tables["requests"]),
            limiter=RateLimiter(tables["ratelimit"]),
            audit=AuditLog(tables["audit"]),
            admin=AdminGate(engine, ssm, cognito, "/p", "us-east-1_TEST", True),
            model=model,
            catalog=catalog,
            ses=ses,
        )
        ingest_corpus(knowledge)
        identity.ensure_user(RECRUITER, "recruiter@example.com")
        tables["identity"].put_item(
            Item={
                "user_id": ADMIN,
                "email": "me@example.com",
                "tags": {"public", "sentinel_admin", *restricted_tags(catalog)},
            }
        )
        cognito.mfa.add(ADMIN)
        yield Harness(services, vectors, model, key, cognito, ssm, ses)
