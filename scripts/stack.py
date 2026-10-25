"""Deployed stack outputs, shared by the operator scripts."""

from typing import Any

import boto3

STACK = "SentinelResume"


def outputs(region: str, stack: str = STACK) -> dict[str, str]:
    cfn: Any = boto3.client("cloudformation", region_name=region)
    described = cfn.describe_stacks(StackName=stack)["Stacks"][0]
    return {o["OutputKey"]: o["OutputValue"] for o in described.get("Outputs", [])}
