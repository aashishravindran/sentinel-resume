"""Cognito triggers: the daily sign-up cap and the default scope on confirmation."""

from typing import Any

import boto3
import pytest
from moto import mock_aws

from sentinel_resume import triggers

SUB = "11111111-aaaa-bbbb-cccc-000000000001"


@pytest.fixture
def tables(monkeypatch: pytest.MonkeyPatch) -> Any:
    with mock_aws():
        ddb = boto3.resource("dynamodb", region_name="us-east-1")
        made = {}
        for name, pk in (("identity", "user_id"), ("ratelimit", "pk")):
            made[name] = ddb.create_table(
                TableName=name,
                KeySchema=[{"AttributeName": pk, "KeyType": "HASH"}],
                AttributeDefinitions=[{"AttributeName": pk, "AttributeType": "S"}],
                BillingMode="PAY_PER_REQUEST",
            )
        monkeypatch.setenv("AWS_DEFAULT_REGION", "us-east-1")
        monkeypatch.setenv("IDENTITY_TABLE", "identity")
        monkeypatch.setenv("RATELIMIT_TABLE", "ratelimit")
        monkeypatch.setenv("SIGNUPS_PER_DAY", "2")
        yield made


def _confirmation(source: str = "PostConfirmation_ConfirmSignUp") -> dict[str, Any]:
    return {
        "triggerSource": source,
        "request": {"userAttributes": {"sub": SUB, "email": "r@example.com"}},
    }


def test_confirmed_user_gets_public_scope(tables: Any) -> None:
    event = _confirmation()
    assert triggers.post_confirmation(event, None) is event
    item = tables["identity"].get_item(Key={"user_id": SUB})["Item"]
    assert item["tags"] == {"public"}
    assert item["email"] == "r@example.com"


def test_confirmation_never_overwrites_an_existing_user(tables: Any) -> None:
    tables["identity"].put_item(Item={"user_id": SUB, "tags": {"public", "sentinel_admin"}})
    triggers.post_confirmation(_confirmation(), None)
    assert tables["identity"].get_item(Key={"user_id": SUB})["Item"]["tags"] == {
        "public",
        "sentinel_admin",
    }


def test_forgot_password_confirmation_is_ignored(tables: Any) -> None:
    triggers.post_confirmation(_confirmation("PostConfirmation_ConfirmForgotPassword"), None)
    assert "Item" not in tables["identity"].get_item(Key={"user_id": SUB})


def test_sign_ups_are_capped_per_day(tables: Any) -> None:
    event: dict[str, Any] = {"triggerSource": "PreSignUp_SignUp", "request": {}}
    triggers.pre_sign_up(event, None)
    triggers.pre_sign_up(event, None)
    with pytest.raises(Exception, match="paused for today"):
        triggers.pre_sign_up(event, None)


def test_admin_created_users_never_use_up_the_cap(tables: Any) -> None:
    # Demo and e2e users are created through the admin API on every deploy.
    admin: dict[str, Any] = {"triggerSource": "PreSignUp_AdminCreateUser", "request": {}}
    for _ in range(10):
        triggers.pre_sign_up(admin, None)
    triggers.pre_sign_up({"triggerSource": "PreSignUp_SignUp", "request": {}}, None)
