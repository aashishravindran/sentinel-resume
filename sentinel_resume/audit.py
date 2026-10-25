"""A durable record of every access decision that changes or tests someone's scope."""

import json
import logging
import time
import uuid
from collections.abc import Callable
from typing import Any

from boto3.dynamodb.conditions import Key

logger = logging.getLogger("sentinel_resume.audit")

RETENTION_SECONDS = 90 * 24 * 3600


class AuditLog:
    def __init__(self, table: Any, clock: Callable[[], float] = time.time):
        self.table = table
        self.clock = clock

    def record(self, action: str, actor: str, **details: Any) -> None:
        now = int(self.clock())
        entry = {"action": action, "actor": actor, **details}
        logger.info(json.dumps({"audit": entry}, default=str))
        try:
            self.table.put_item(
                Item={
                    "pk": f"{now:012d}#{uuid.uuid4().hex[:8]}",
                    "day": time.strftime("%Y-%m-%d", time.gmtime(now)),
                    "at": now,
                    "expires_at": now + RETENTION_SECONDS,
                    **entry,
                }
            )
        except Exception:
            # The CloudWatch line above is the fallback; an audit write never fails the request.
            logger.exception("audit write failed")

    def recent(self, day: str, limit: int = 50) -> list[dict[str, Any]]:
        response = self.table.query(
            IndexName="by_day",
            KeyConditionExpression=Key("day").eq(day),
            ScanIndexForward=False,
            Limit=limit,
        )
        return response.get("Items", [])
