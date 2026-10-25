"""End-to-end against the deployed site: sign up, chat, get denied, request, approve, expire.

Creates a throwaway recruiter and a throwaway TOTP admin, temporarily adds the
admin to the allowlist, and removes both (and restores the allowlist) at the end.

    uv run python -m scripts.e2e [--region us-east-1] [--quota]
"""

import argparse
import base64
import hashlib
import hmac
import json
import secrets
import struct
import time
import urllib.error
import urllib.request
from typing import Any

import boto3

from scripts.stack import outputs
from sentinel_resume.catalog import load_catalog, restricted_tags

OFFER_SECRET = "187,000"


def totp(secret: str, at: float | None = None) -> str:
    key = base64.b32decode(secret + "=" * (-len(secret) % 8))
    counter = struct.pack(">Q", int((at or time.time()) // 30))
    digest = hmac.new(key, counter, hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    return f"{(struct.unpack('>I', digest[offset : offset + 4])[0] & 0x7FFFFFFF) % 1_000_000:06d}"


def _sub_of(cognito: Any, pool: str, email: str) -> str:
    user = cognito.admin_get_user(UserPoolId=pool, Username=email)
    return next(a["Value"] for a in user["UserAttributes"] if a["Name"] == "sub")


class Site:
    def __init__(self, url: str):
        self.url = url

    def call(self, method: str, path: str, token: str, body: Any = None) -> tuple[int, Any]:
        request = urllib.request.Request(
            f"{self.url}/api{path}",
            method=method,
            data=json.dumps(body).encode() if body is not None else None,
            headers={"authorization": f"Bearer {token}", "content-type": "application/json"},
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return response.status, json.loads(response.read())
        except urllib.error.HTTPError as exc:
            return exc.code, json.loads(exc.read() or b"{}")


def check(label: str, ok: bool, detail: Any = "") -> None:
    print(f"{'PASS' if ok else 'FAIL'}  {label}" + (f"  ({detail})" if detail and not ok else ""))
    if not ok:
        raise SystemExit(1)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--region", default="us-east-1")
    parser.add_argument("--quota", action="store_true", help="also exhaust the hourly chat quota")
    args = parser.parse_args()

    out = outputs(args.region)
    site = Site(out["SiteUrl"])
    pool, client_id = out["UserPoolId"], out["UserPoolClientId"]
    cognito: Any = boto3.client("cognito-idp", region_name=args.region)
    ssm: Any = boto3.client("ssm", region_name=args.region)
    ddb: Any = boto3.resource("dynamodb", region_name=args.region)
    identity = ddb.Table(out["IdentityTableName"])
    run = secrets.token_hex(4)
    users: list[str] = []
    saved_allowlist: str | None = None

    def make_user(email: str) -> tuple[str, str]:
        password = secrets.token_urlsafe(18) + "aA1"
        created = cognito.admin_create_user(
            UserPoolId=pool,
            Username=email,
            MessageAction="SUPPRESS",
            UserAttributes=[
                {"Name": "email", "Value": email},
                {"Name": "email_verified", "Value": "true"},
            ],
        )
        cognito.admin_set_user_password(
            UserPoolId=pool, Username=email, Password=password, Permanent=True
        )
        users.append(email)
        sub = next(a["Value"] for a in created["User"]["Attributes"] if a["Name"] == "sub")
        # Admin-created users skip the PostConfirmation trigger; give them what sign-up would.
        identity.put_item(Item={"user_id": sub, "tags": {"public"}, "email": email})
        return sub, password

    def sign_in(email: str, password: str, totp_secret: str | None = None) -> str:
        result = cognito.initiate_auth(
            ClientId=client_id,
            AuthFlow="USER_PASSWORD_AUTH",
            AuthParameters={"USERNAME": email, "PASSWORD": password},
        )
        if result.get("ChallengeName") == "SOFTWARE_TOKEN_MFA":
            assert totp_secret
            result = cognito.respond_to_auth_challenge(
                ClientId=client_id,
                ChallengeName="SOFTWARE_TOKEN_MFA",
                Session=result["Session"],
                ChallengeResponses={
                    "USERNAME": email,
                    "SOFTWARE_TOKEN_MFA_CODE": totp(totp_secret),
                },
            )
        return result["AuthenticationResult"]["AccessToken"]

    try:
        # --- self sign-up, as the site does it ------------------------------------------------
        # SignUp fires the pre-sign-up trigger; AdminConfirmSignUp stands in for typing the
        # emailed code and fires the post-confirmation trigger. The SES mailbox simulator
        # accepts the verification email without a real inbox.
        signup_email = f"success+signup-{run}@simulator.amazonses.com"
        signup_pw = secrets.token_urlsafe(18) + "aA1"
        cognito.sign_up(
            ClientId=client_id,
            Username=signup_email,
            Password=signup_pw,
            UserAttributes=[{"Name": "email", "Value": signup_email}],
        )
        users.append(signup_email)
        item = identity.get_item(Key={"user_id": _sub_of(cognito, pool, signup_email)})
        check("no scope before email is confirmed", "Item" not in item, item)
        cognito.admin_confirm_sign_up(UserPoolId=pool, Username=signup_email)
        signed_up = sign_in(signup_email, signup_pw)
        status, me = site.call("GET", "/me", signed_up)
        check(
            "self sign-up gets public scope from the trigger",
            status == 200 and me["scope"] == ["public"] and me["email"] == signup_email,
            me,
        )

        # --- recruiter ------------------------------------------------------------------------
        recruiter_email = f"e2e-recruiter-{run}@example.com"
        _, recruiter_pw = make_user(recruiter_email)
        recruiter = sign_in(recruiter_email, recruiter_pw)

        status, me = site.call("GET", "/me", recruiter)
        check("recruiter scope is public only", status == 200 and me["scope"] == ["public"], me)

        status, reply = site.call(
            "POST", "/chat", recruiter, {"question": "Where did Aashish study?"}
        )
        check("resume question is answered", status == 200 and reply["citations"], reply)
        print(f"      answer: {reply['answer'][:160]!r}")

        ask_offer = {"question": "What base salary and equity did the 2024 offer letter include?"}
        status, reply = site.call("POST", "/chat", recruiter, ask_offer)
        check(
            "offer letter is not retrievable",
            status == 200
            and "Offer letter (2024)" not in reply["citations"]
            and OFFER_SECRET not in reply["answer"],
            reply,
        )

        status, _ = site.call("GET", "/admin/overview", recruiter)
        check("recruiter cannot open /admin", status == 403, status)

        status, reply = site.call(
            "POST", "/requests", recruiter, {"tag": "doc_tax_w2_2025", "reason": "e2e"}
        )
        check("tax form cannot be requested", status == 400, reply)

        status, reply = site.call(
            "POST", "/requests", recruiter, {"tag": "doc_offer_letter", "reason": f"e2e {run}"}
        )
        check("access request filed", status == 200, reply)
        request_id = reply["request"]["request_id"]

        # --- admin (TOTP) ---------------------------------------------------------------------
        admin_email = f"e2e-admin-{run}@example.com"
        admin_sub, admin_pw = make_user(admin_email)
        token = sign_in(admin_email, admin_pw)
        secret = cognito.associate_software_token(AccessToken=token)["SecretCode"]
        cognito.verify_software_token(AccessToken=token, UserCode=totp(secret))
        cognito.set_user_mfa_preference(
            AccessToken=token,
            SoftwareTokenMfaSettings={"Enabled": True, "PreferredMfa": True},
        )
        cognito.admin_add_user_to_group(UserPoolId=pool, Username=admin_email, GroupName="admin")
        identity.update_item(
            Key={"user_id": admin_sub},
            UpdateExpression="ADD tags :t",
            ExpressionAttributeValues={":t": {"sentinel_admin", *restricted_tags(load_catalog())}},
        )
        try:
            saved_allowlist = ssm.get_parameter(Name=out["AdminSubsParam"])["Parameter"]["Value"]
        except ssm.exceptions.ParameterNotFound:
            saved_allowlist = "none"
        current = {s for s in saved_allowlist.split(",") if s and s != "none"}
        ssm.put_parameter(
            Name=out["AdminSubsParam"],
            Value=",".join(sorted(current | {admin_sub})),
            Type="String",
            Overwrite=True,
        )
        time.sleep(31)  # a fresh TOTP window for the MFA sign-in
        admin = sign_in(admin_email, admin_pw, secret)

        status, overview = site.call("GET", "/admin/overview", admin)
        pending = [r["request_id"] for r in overview.get("pending", [])]
        check("admin sees the pending request", status == 200 and request_id in pending, overview)

        status, reply = site.call(
            "POST", f"/admin/requests/{request_id}/approve", admin, {"minutes": 1}
        )
        check("admin approves for 1 minute", status == 200, reply)

        status, reply = site.call("POST", "/chat", recruiter, ask_offer)
        check(
            "offer letter retrievable after approval",
            status == 200 and "Offer letter (2024)" in reply["citations"],
            reply,
        )
        print(f"      answer: {reply['answer'][:160]!r}")

        print("      waiting for the grant to expire…")
        time.sleep(65)
        status, reply = site.call("POST", "/chat", recruiter, ask_offer)
        check(
            "offer letter gone after expiry",
            status == 200 and "Offer letter (2024)" not in reply["citations"],
            reply,
        )

        if args.quota:
            statuses = [
                site.call("POST", "/chat", recruiter, {"question": "skills?"})[0] for _ in range(20)
            ]
            check("hourly chat quota returns 429", 429 in statuses, statuses)
    finally:
        if saved_allowlist is not None:
            ssm.put_parameter(
                Name=out["AdminSubsParam"], Value=saved_allowlist, Type="String", Overwrite=True
            )
        for email in users:
            identity.delete_item(Key={"user_id": _sub_of(cognito, pool, email)})
            cognito.admin_delete_user(UserPoolId=pool, Username=email)
        print(f"cleaned up {len(users)} test user(s)")


if __name__ == "__main__":
    main()
