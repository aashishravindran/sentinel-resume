"""Who is calling, and whether they may administer.

Identity is the verified access token's ``sub``; nothing in a request body is
ever read as an identity. Admin needs four independent checks, so no single
misconfiguration (a console group edit, a stray tag) makes someone an admin.
"""

from collections.abc import Mapping
from typing import Any

from sentinel_engine.engine import SentinelEngine
from sentinel_engine.errors import AccessDeniedError
from sentinel_engine.oidc import TokenVerifier
from sentinel_engine.principal import Principal

ADMIN_GROUP = "admin"


class NotAdmin(AccessDeniedError):
    def __init__(self, check: str):
        super().__init__(f"not an admin: {check}")
        self.check = check


def authenticate(headers: Mapping[str, str], verifier: TokenVerifier) -> Principal:
    """The caller from the Authorization header. Raises IdentityError on anything off."""
    principal = verifier.verify_authorization_header(headers.get("authorization"))
    if principal.claims.get("token_use") != "access":
        # ID tokens carry profile claims and a different audience; only access tokens are accepted.
        raise AccessDeniedError("an access token is required")
    return principal


class AdminGate:
    def __init__(
        self,
        engine: SentinelEngine,
        ssm: Any,
        cognito: Any,
        allowlist_param: str,
        user_pool_id: str,
        require_mfa: bool,
    ):
        self.engine = engine
        self.ssm = ssm
        self.cognito = cognito
        self.allowlist_param = allowlist_param
        self.user_pool_id = user_pool_id
        self.require_mfa = require_mfa

    def _allowlist(self) -> set[str]:
        # Read live on every call: removing an admin applies on their next request.
        value = self.ssm.get_parameter(Name=self.allowlist_param)["Parameter"]["Value"]
        return {s.strip() for s in value.split(",") if s.strip() and s.strip() != "none"}

    def _has_mfa(self, username: str) -> bool:
        user = self.cognito.admin_get_user(UserPoolId=self.user_pool_id, Username=username)
        return "SOFTWARE_TOKEN_MFA" in (user.get("UserMFASettingList") or [])

    async def require(self, principal: Principal) -> None:
        """Raise NotAdmin unless every check passes. Any error counts as a failed check."""
        groups = principal.claims.get("cognito:groups") or []
        if ADMIN_GROUP not in groups:
            raise NotAdmin("group")
        try:
            allowed = principal.user_id in self._allowlist()
        except Exception:
            allowed = False
        if not allowed:
            raise NotAdmin("allowlist")
        if not await self.engine.is_admin(principal):
            raise NotAdmin("tag")
        if self.require_mfa:
            try:
                mfa = self._has_mfa(str(principal.claims.get("username", "")))
            except Exception:
                mfa = False
            if not mfa:
                raise NotAdmin("mfa")

    async def check(self, principal: Principal) -> bool:
        try:
            await self.require(principal)
        except AccessDeniedError:
            return False
        return True
