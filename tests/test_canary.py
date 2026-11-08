"""The scheduled canary: what it checks, and that any failed check raises."""

import json
from typing import Any

import pytest

from sentinel_resume import canary

SITE = "https://site.example"


class FakeCognito:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def initiate_auth(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(kwargs)
        return {"AuthenticationResult": {"AccessToken": "tok"}}


def fake_site(
    monkeypatch: pytest.MonkeyPatch,
    page: tuple[int, bytes] = (200, b'<div id="root"></div>'),
    me: tuple[int, Any] = (200, {"scope": ["public"]}),
    chat: tuple[int, Any] = (200, {"answer": "Stony Brook [Resume]", "citations": ["Resume"]}),
) -> list[tuple[str, str, Any]]:
    seen: list[tuple[str, str, Any]] = []

    def fetch(url: str, token: str = "", body: Any = None) -> tuple[int, bytes]:
        seen.append((url, token, body))
        if url == SITE:
            return page
        status, payload = me if url.endswith("/api/me") else chat
        return status, json.dumps(payload).encode()

    monkeypatch.setattr(canary, "_fetch", fetch)
    return seen


def test_passes_when_the_site_answers(monkeypatch: pytest.MonkeyPatch) -> None:
    seen = fake_site(monkeypatch)
    cognito = FakeCognito()
    result = canary.run(SITE, "client", "pw", cognito)
    assert result["citations"] == ["Resume"]
    assert cognito.calls[0]["AuthParameters"]["USERNAME"] == canary.CANARY_EMAIL
    assert [u for u, _, _ in seen] == [SITE, f"{SITE}/api/me", f"{SITE}/api/chat"]
    assert seen[2][1] == "tok" and seen[2][2] == {"question": canary.QUESTION}


@pytest.mark.parametrize(
    ("override", "label"),
    [
        ({"page": (503, b"")}, "site loads"),
        ({"page": (200, b"<html></html>")}, "site loads"),
        ({"me": (401, {"error": "unauthorized"})}, "/me shows public scope"),
        ({"me": (200, {"scope": ["public", "doc_offer_letter"]})}, "/me shows public scope"),
        ({"chat": (503, {"error": "resting"})}, "question is answered"),
        ({"chat": (200, {"answer": "no", "citations": []})}, "question is answered"),
    ],
)
def test_any_failed_check_raises(
    monkeypatch: pytest.MonkeyPatch, override: dict[str, Any], label: str
) -> None:
    fake_site(monkeypatch, **override)
    with pytest.raises(canary.CanaryFailed, match=label):
        canary.run(SITE, "client", "pw", FakeCognito())
