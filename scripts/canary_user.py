"""Create the canary's user, or give it a fresh password. Runs on every deploy.

    uv run python -m scripts.canary_user

The user has public scope only, like any self sign-up. Its password lives in an SSM parameter
that only the canary Lambda reads (sentinel_resume/canary.py).
"""

import argparse
import secrets
from typing import Any

import boto3

from scripts.stack import outputs
from sentinel_resume.canary import CANARY_EMAIL, PASSWORD_PARAM


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--region", default="us-east-1")
    args = parser.parse_args()
    out = outputs(args.region)
    pool = out["UserPoolId"]
    cognito: Any = boto3.client("cognito-idp", region_name=args.region)
    ssm: Any = boto3.client("ssm", region_name=args.region)
    ddb: Any = boto3.resource("dynamodb", region_name=args.region)

    try:
        user = cognito.admin_create_user(
            UserPoolId=pool,
            Username=CANARY_EMAIL,
            MessageAction="SUPPRESS",
            UserAttributes=[
                {"Name": "email", "Value": CANARY_EMAIL},
                {"Name": "email_verified", "Value": "true"},
            ],
        )["User"]
        attributes = user["Attributes"]
    except cognito.exceptions.UsernameExistsException:
        attributes = cognito.admin_get_user(UserPoolId=pool, Username=CANARY_EMAIL)[
            "UserAttributes"
        ]
    sub = next(a["Value"] for a in attributes if a["Name"] == "sub")
    password = secrets.token_urlsafe(24) + "aA1"
    cognito.admin_set_user_password(
        UserPoolId=pool, Username=CANARY_EMAIL, Password=password, Permanent=True
    )
    # Admin-created users skip the PostConfirmation trigger; write what sign-up would.
    ddb.Table(out["IdentityTableName"]).put_item(
        Item={"user_id": sub, "tags": {"public"}, "email": CANARY_EMAIL}
    )
    ssm.put_parameter(Name=PASSWORD_PARAM, Value=password, Type="String", Overwrite=True)
    print(f"{CANARY_EMAIL}: password rotated")


if __name__ == "__main__":
    main()
