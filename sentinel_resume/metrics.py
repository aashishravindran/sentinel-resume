"""CloudWatch metrics in the Embedded Metric Format: a stdout line each, no API call, no extra IAM.

Every name here is a custom metric (about $0.30 a month each), so the set stays small and has a
single fixed dimension. Alarms and the dashboard in infra/lib/monitoring.ts read these names.
"""

import json
import time

NAMESPACE = "SentinelResume"
DIMENSIONS = {"Service": "resume"}


def emit(**metrics: float) -> None:
    """Write metrics, e.g. emit(Questions=1, ChatLatencyMs=812). Names ending in Ms are in ms."""
    if not metrics:
        return
    document = {
        "_aws": {
            "Timestamp": int(time.time() * 1000),
            "CloudWatchMetrics": [
                {
                    "Namespace": NAMESPACE,
                    "Dimensions": [list(DIMENSIONS)],
                    "Metrics": [
                        {"Name": name, "Unit": "Milliseconds" if name.endswith("Ms") else "Count"}
                        for name in metrics
                    ],
                }
            ],
        },
        **DIMENSIONS,
        **metrics,
    }
    print(json.dumps(document), flush=True)
