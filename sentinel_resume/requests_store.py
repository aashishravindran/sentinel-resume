"""Access requests: one item per (user, document tag), so at most one open request per doc."""

import time
from collections.abc import Callable
from typing import Any

from boto3.dynamodb.conditions import Key
from sentinel_engine.principal import validate_subject

MAX_REASON_CHARS = 500


class DuplicateRequest(Exception):
    pass


class RequestNotPending(Exception):
    pass


def request_id(user_id: str, tag: str) -> str:
    return f"{validate_subject(user_id)}:{tag}"


class RequestsStore:
    def __init__(self, table: Any, clock: Callable[[], float] = time.time):
        self.table = table
        self.clock = clock

    def create(self, user_id: str, email: str, tag: str, reason: str) -> dict[str, Any]:
        item = {
            "request_id": request_id(user_id, tag),
            "user_id": user_id,
            "email": email,
            "tag": tag,
            "reason": reason.strip()[:MAX_REASON_CHARS],
            "status": "pending",
            "created_at": int(self.clock()),
        }
        try:
            # A decided request can be filed again; an open one cannot be duplicated.
            self.table.put_item(
                Item=item,
                ConditionExpression="attribute_not_exists(request_id) OR #s <> :pending",
                ExpressionAttributeNames={"#s": "status"},
                ExpressionAttributeValues={":pending": "pending"},
            )
        except self.table.meta.client.exceptions.ConditionalCheckFailedException:
            raise DuplicateRequest(tag) from None
        return item

    def get(self, rid: str) -> dict[str, Any] | None:
        return self.table.get_item(Key={"request_id": rid}, ConsistentRead=True).get("Item")

    def for_user(self, user_id: str, tags: list[str]) -> list[dict[str, Any]]:
        items = [self.get(request_id(user_id, tag)) for tag in tags]
        return [i for i in items if i]

    def by_status(self, status: str) -> list[dict[str, Any]]:
        response = self.table.query(
            IndexName="by_status",
            KeyConditionExpression=Key("status").eq(status),
            ScanIndexForward=False,
        )
        return response.get("Items", [])

    def decide(
        self, rid: str, status: str, decided_by: str, expires_at: int | None
    ) -> dict[str, Any]:
        """Approve or deny an open request. Raises RequestNotPending if it was already decided."""
        values: dict[str, Any] = {
            ":new": status,
            ":pending": "pending",
            ":at": int(self.clock()),
            ":by": decided_by,
        }
        update = "SET #s = :new, decided_at = :at, decided_by = :by"
        if expires_at is not None:
            update += ", expires_at = :exp"
            values[":exp"] = expires_at
        try:
            response = self.table.update_item(
                Key={"request_id": rid},
                UpdateExpression=update,
                ConditionExpression="#s = :pending",
                ExpressionAttributeNames={"#s": "status"},
                ExpressionAttributeValues=values,
                ReturnValues="ALL_NEW",
            )
        except self.table.meta.client.exceptions.ConditionalCheckFailedException:
            raise RequestNotPending(rid) from None
        return response["Attributes"]
