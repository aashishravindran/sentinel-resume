"""Fixed-window counters in DynamoDB: one atomic conditional increment per check."""

import time
from collections.abc import Callable
from typing import Any


class RateLimited(Exception):
    def __init__(self, retry_after: int, scope: str):
        super().__init__(f"rate limited ({scope}); retry after {retry_after}s")
        self.retry_after = retry_after
        self.scope = scope


class RateLimiter:
    def __init__(self, table: Any, clock: Callable[[], float] = time.time):
        self.table = table
        self.clock = clock

    def hit(self, key: str, limit: int, window_seconds: int) -> None:
        """Count one event against *key*; raise RateLimited once *limit* is reached."""
        now = int(self.clock())
        window = now // window_seconds
        window_end = (window + 1) * window_seconds
        try:
            self.table.update_item(
                Key={"pk": f"{key}#{window_seconds}#{window}"},
                UpdateExpression="ADD hits :one SET expires_at = :ttl",
                ConditionExpression="attribute_not_exists(hits) OR hits < :limit",
                ExpressionAttributeValues={":one": 1, ":limit": limit, ":ttl": window_end + 60},
            )
        except self.table.meta.client.exceptions.ConditionalCheckFailedException:
            raise RateLimited(max(1, window_end - now), key) from None
