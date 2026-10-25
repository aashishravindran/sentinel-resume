"""Make exactly the people in infra/admins.json admins. The only way anyone becomes one.

Each listed email must already have signed up. For each, this adds the Cognito
`admin` group, the `sentinel_admin` tag and every per-document tag, and writes
the allowlist parameter the API reads on every admin call. Anyone holding admin
who is no longer listed loses all three.

    uv run python -m scripts.sync_admins [--region us-east-1] [--dry-run]
"""

import argparse
import json
from pathlib import Path
from typing import Any

import boto3

from scripts.stack import outputs
from sentinel_resume.catalog import load_catalog, restricted_tags

ADMINS_FILE = Path(__file__).parent.parent / "infra" / "admins.json"
ADMIN_GROUP = "admin"


def _user_by_email(cognito: Any, pool: str, email: str) -> dict[str, Any]:
    users = cognito.list_users(UserPoolId=pool, Filter=f'email = "{email}"')["Users"]
    if len(users) != 1:
        raise SystemExit(f"{email}: expected one Cognito user, found {len(users)}. Sign up first.")
    return users[0]


def _sub(user: dict[str, Any]) -> str:
    return next(a["Value"] for a in user["Attributes"] if a["Name"] == "sub")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--region", default="us-east-1")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    out = outputs(args.region)
    pool = out["UserPoolId"]
    cognito: Any = boto3.client("cognito-idp", region_name=args.region)
    ssm: Any = boto3.client("ssm", region_name=args.region)
    ddb: Any = boto3.resource("dynamodb", region_name=args.region)
    table = ddb.Table(out["IdentityTableName"])
    admin_tags = {"public", "sentinel_admin", *restricted_tags(load_catalog())}

    emails = json.loads(ADMINS_FILE.read_text())["admins"]
    wanted = {_sub(u): u for u in (_user_by_email(cognito, pool, e) for e in emails)}
    current = {
        _sub(u): u
        for u in cognito.list_users_in_group(UserPoolId=pool, GroupName=ADMIN_GROUP)["Users"]
    }

    for sub, user in wanted.items():
        print(f"admin   {user['Username']} ({sub})")
        if args.dry_run:
            continue
        cognito.admin_add_user_to_group(
            UserPoolId=pool, Username=user["Username"], GroupName=ADMIN_GROUP
        )
        table.update_item(
            Key={"user_id": sub},
            UpdateExpression="ADD tags :t",
            ExpressionAttributeValues={":t": admin_tags},
        )
    for sub, user in current.items():
        if sub in wanted:
            continue
        print(f"remove  {user['Username']} ({sub})")
        if args.dry_run:
            continue
        cognito.admin_remove_user_from_group(
            UserPoolId=pool, Username=user["Username"], GroupName=ADMIN_GROUP
        )
        table.update_item(
            Key={"user_id": sub},
            UpdateExpression="DELETE tags :t",
            ExpressionAttributeValues={":t": admin_tags - {"public"}},
        )
    if not args.dry_run:
        ssm.put_parameter(
            Name=out["AdminSubsParam"],
            Value=",".join(sorted(wanted)) or "none",
            Type="String",
            Overwrite=True,
        )
    print(f"{len(wanted)} admin(s). Admins must enable an authenticator app (MFA) to use /admin.")


if __name__ == "__main__":
    main()
