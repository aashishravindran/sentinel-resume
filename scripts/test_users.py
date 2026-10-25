"""Demo personas with easy passwords, for trying the site by hand.

    uv run python -m scripts.test_users create   # prints the logins; writes .test-users.json
    uv run python -m scripts.test_users delete

The logins are published in the README's "Try it out" section on purpose: the
sensitive documents are synthetic. Grants expire in 30 days; re-run `create` to
renew them (and reset the passwords if anyone changed them).
"""

import argparse
import json
import time
from pathlib import Path
from typing import Any

import boto3

from scripts.stack import outputs

CREDENTIALS = Path(__file__).parent.parent / ".test-users.json"
GRANT_DAYS = 30

PERSONAS: dict[str, tuple[str, list[str]]] = {
    "basic.recruiter@example.com": ("Demo-Basic-2026", []),
    "offer.recruiter@example.com": ("Demo-Offer-2026", ["doc_offer_letter"]),
    "full.recruiter@example.com": (
        "Demo-Full-2026",
        ["doc_offer_letter", "doc_salary_history", "doc_references"],
    ),
}


def _sub(attributes: list[dict[str, str]]) -> str:
    return next(a["Value"] for a in attributes if a["Name"] == "sub")


def create(cognito: Any, table: Any, pool: str) -> None:
    expires_at = int(time.time()) + GRANT_DAYS * 86400
    for email, (password, grants) in PERSONAS.items():
        try:
            user = cognito.admin_create_user(
                UserPoolId=pool,
                Username=email,
                MessageAction="SUPPRESS",
                UserAttributes=[
                    {"Name": "email", "Value": email},
                    {"Name": "email_verified", "Value": "true"},
                ],
            )["User"]
            sub = _sub(user["Attributes"])
        except cognito.exceptions.UsernameExistsException:
            sub = _sub(cognito.admin_get_user(UserPoolId=pool, Username=email)["UserAttributes"])
        cognito.admin_set_user_password(
            UserPoolId=pool, Username=email, Password=password, Permanent=True
        )
        # Admin-created users skip the PostConfirmation trigger; write what sign-up would.
        item: dict[str, Any] = {"user_id": sub, "tags": {"public"}, "email": email}
        item.update({f"grant_{tag}": expires_at for tag in grants})
        table.put_item(Item=item)
        print(f"{email:<30} {password:<18} grants: {', '.join(grants) or 'none'}")
    CREDENTIALS.write_text(
        json.dumps({email: password for email, (password, _) in PERSONAS.items()}, indent=2)
    )
    print(f"\nSaved to {CREDENTIALS.name} (gitignored). Grants expire in {GRANT_DAYS} days.")


def delete(cognito: Any, table: Any, pool: str) -> None:
    for email in PERSONAS:
        try:
            user = cognito.admin_get_user(UserPoolId=pool, Username=email)
        except cognito.exceptions.UserNotFoundException:
            continue
        table.delete_item(Key={"user_id": _sub(user["UserAttributes"])})
        cognito.admin_delete_user(UserPoolId=pool, Username=email)
        print(f"deleted {email}")
    CREDENTIALS.unlink(missing_ok=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["create", "delete"])
    parser.add_argument("--region", default="us-east-1")
    args = parser.parse_args()
    out = outputs(args.region)
    cognito: Any = boto3.client("cognito-idp", region_name=args.region)
    ddb: Any = boto3.resource("dynamodb", region_name=args.region)
    table = ddb.Table(out["IdentityTableName"])
    (create if args.action == "create" else delete)(cognito, table, out["UserPoolId"])


if __name__ == "__main__":
    main()
