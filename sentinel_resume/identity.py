"""Who may read what: base tags plus time-boxed grants, in one DynamoDB item per user.

    {"user_id": "<cognito sub>", "tags": {"public"}, "grant_doc_offer_letter": 1767225600}

A grant is a top-level number attribute holding its expiry (epoch seconds), so
approving and revoking are single atomic writes and expiry needs no sweeper:
an expired grant is simply not returned on the next lookup.
"""

import asyncio
import contextlib
import time
from collections.abc import Callable
from decimal import Decimal
from typing import Any

from sentinel_engine.base import IdentityConnector
from sentinel_engine.filters import is_valid_tag
from sentinel_engine.principal import validate_subject

GRANT_PREFIX = "grant_"
DEFAULT_TAGS = frozenset({"public"})


def _grant_attr(tag: str) -> str:
    if not is_valid_tag(tag):
        raise ValueError(f"invalid tag: {tag!r}")
    return f"{GRANT_PREFIX}{tag}"


def active_grants(item: dict[str, Any], now: float) -> dict[str, int]:
    """Grants on *item* that have not expired, as tag -> expiry."""
    grants: dict[str, int] = {}
    for key, value in item.items():
        if not key.startswith(GRANT_PREFIX) or not isinstance(value, int | float | Decimal):
            continue
        if value > now:
            grants[key.removeprefix(GRANT_PREFIX)] = int(value)
    return grants


def tags_from_item(item: dict[str, Any], now: float) -> set[str]:
    base = item.get("tags")
    # A tags attribute of the wrong type grants nothing.
    tags = {t for t in base if isinstance(t, str)} if isinstance(base, set | list) else set()
    return tags | set(active_grants(item, now))


class IdentityStore:
    """Reads and writes the identity table. Strongly consistent reads: revocation is immediate."""

    def __init__(self, table: Any, clock: Callable[[], float] = time.time):
        self.table = table
        self.clock = clock

    def item(self, user_id: str) -> dict[str, Any]:
        key = {"user_id": validate_subject(user_id)}
        response = self.table.get_item(Key=key, ConsistentRead=True)
        return response.get("Item", {})

    def tags(self, user_id: str) -> set[str]:
        return tags_from_item(self.item(user_id), self.clock())

    def grants(self, user_id: str) -> dict[str, int]:
        return active_grants(self.item(user_id), self.clock())

    def ensure_user(self, user_id: str, email: str) -> None:
        """Create a new sign-up with the default tags. Never touches an existing user."""
        item = {"user_id": validate_subject(user_id), "tags": set(DEFAULT_TAGS), "email": email}
        with contextlib.suppress(self.table.meta.client.exceptions.ConditionalCheckFailedException):
            self.table.put_item(Item=item, ConditionExpression="attribute_not_exists(user_id)")

    def grant(self, user_id: str, tag: str, expires_at: int) -> None:
        self.table.update_item(
            Key={"user_id": validate_subject(user_id)},
            UpdateExpression="SET #g = :exp",
            ConditionExpression="attribute_exists(user_id)",
            ExpressionAttributeNames={"#g": _grant_attr(tag)},
            ExpressionAttributeValues={":exp": expires_at},
        )

    def revoke(self, user_id: str, tag: str) -> None:
        self.table.update_item(
            Key={"user_id": validate_subject(user_id)},
            UpdateExpression="REMOVE #g",
            ExpressionAttributeNames={"#g": _grant_attr(tag)},
        )

    def all_grants(self) -> list[dict[str, Any]]:
        """Every unexpired grant, for the admin page. A scan is fine at demo scale."""
        now = self.clock()
        rows: list[dict[str, Any]] = []
        kwargs: dict[str, Any] = {}
        while True:
            page = self.table.scan(**kwargs)
            for item in page.get("Items", []):
                for tag, expires_at in active_grants(item, now).items():
                    rows.append(
                        {
                            "user_id": item["user_id"],
                            "email": item.get("email", ""),
                            "tag": tag,
                            "expires_at": expires_at,
                        }
                    )
            if "LastEvaluatedKey" not in page:
                return sorted(rows, key=lambda r: r["expires_at"])
            kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]


class ExpiringDdbIdentity(IdentityConnector):
    """The engine's identity connector over IdentityStore. Errors propagate: the engine denies."""

    def __init__(self, store: IdentityStore):
        self.store = store

    async def get_tags(self, user_id: str) -> set[str]:
        return await asyncio.to_thread(self.store.tags, user_id)
