"""Request access, admin approval, revocation, rate limits and the admin gate."""

from tests.conftest import ADMIN, RECRUITER, Harness


def _admin(h: Harness) -> str:
    return h.token(ADMIN, groups=["admin"])


def test_chat_answers_from_the_resume(harness: Harness) -> None:
    status, body = harness.call(
        "POST /chat", harness.token(RECRUITER), {"question": "Where did Aashish study?"}
    )
    assert status == 200
    assert body["answer"] == "stub answer [Resume]"
    assert "Resume" in body["citations"]
    assert "Stony Brook" in harness.model.prompts[-1]


def test_catalog_shows_what_can_be_requested(harness: Harness) -> None:
    status, body = harness.call("GET /catalog", harness.token(RECRUITER))
    assert status == 200
    docs = {d["doc_id"]: d for d in body["documents"]}
    assert docs["resume"]["has_access"] and not docs["resume"]["requestable"]
    assert docs["offer_letter_2024"]["requestable"] and not docs["offer_letter_2024"]["has_access"]
    assert not docs["tax_w2_2025"]["requestable"]


def test_request_approve_revoke(harness: Harness) -> None:
    recruiter = harness.token(RECRUITER)
    status, body = harness.call(
        "POST /requests", recruiter, {"tag": "doc_offer_letter", "reason": "Comparing offers"}
    )
    assert status == 200 and body["request"]["status"] == "pending"
    assert harness.ses.sent and "Offer letter" in str(harness.ses.sent[0])

    again = {"tag": "doc_offer_letter", "reason": "again"}
    status, _ = harness.call("POST /requests", recruiter, again)
    assert status == 409

    status, overview = harness.call("GET /admin/overview", _admin(harness))
    assert status == 200
    rid = overview["pending"][0]["request_id"]

    status, _ = harness.call(
        "POST /admin/requests/{id}/approve", _admin(harness), {"minutes": 5}, {"id": rid}
    )
    assert status == 200
    status, me = harness.call("GET /me", recruiter)
    assert "doc_offer_letter" in me["scope"]

    status, _ = harness.call(
        "POST /admin/requests/{id}/approve", _admin(harness), {"minutes": 5}, {"id": rid}
    )
    assert status == 409

    harness.call(
        "POST /admin/grants/revoke",
        _admin(harness),
        {"user_id": RECRUITER, "tag": "doc_offer_letter"},
    )
    status, me = harness.call("GET /me", recruiter)
    assert me["scope"] == ["public"]


def test_tax_form_cannot_be_requested(harness: Harness) -> None:
    status, _ = harness.call(
        "POST /requests", harness.token(RECRUITER), {"tag": "doc_tax_w2_2025", "reason": "pls"}
    )
    assert status == 400


def test_admin_tag_cannot_be_requested(harness: Harness) -> None:
    status, _ = harness.call(
        "POST /requests", harness.token(RECRUITER), {"tag": "sentinel_admin", "reason": "pls"}
    )
    assert status == 400


def test_admin_gate_needs_every_check(harness: Harness) -> None:
    # Recruiter, even claiming the admin group in a validly signed token.
    assert harness.call("GET /admin/overview", harness.token(RECRUITER))[0] == 403
    assert harness.call("GET /admin/overview", harness.token(RECRUITER, groups=["admin"]))[0] == 403
    # Real admin without the group claim.
    assert harness.call("GET /admin/overview", harness.token(ADMIN))[0] == 403
    assert harness.call("GET /admin/overview", _admin(harness))[0] == 200

    harness.cognito.mfa.clear()
    assert harness.call("GET /admin/overview", _admin(harness))[0] == 403
    harness.cognito.mfa.add(ADMIN)

    harness.ssm.value = "none"
    assert harness.call("GET /admin/overview", _admin(harness))[0] == 403
    harness.ssm.value = ADMIN

    harness.services.identity.table.update_item(
        Key={"user_id": ADMIN},
        UpdateExpression="DELETE tags :t",
        ExpressionAttributeValues={":t": {"sentinel_admin"}},
    )
    assert harness.call("GET /admin/overview", _admin(harness))[0] == 403


def test_recruiter_cannot_approve_their_own_request(harness: Harness) -> None:
    recruiter = harness.token(RECRUITER, groups=["admin"])
    harness.call("POST /requests", recruiter, {"tag": "doc_references", "reason": "hiring"})
    status, _ = harness.call(
        "POST /admin/requests/{id}/approve",
        recruiter,
        {"minutes": 5},
        {"id": f"{RECRUITER}:doc_references"},
    )
    assert status == 403
    assert "doc_references" not in harness.services.identity.tags(RECRUITER)


def test_chat_rate_limit(harness: Harness) -> None:
    token = harness.token(RECRUITER)
    statuses = [harness.call("POST /chat", token, {"question": "skills"})[0] for _ in range(7)]
    assert statuses[:5] == [200] * 5
    assert statuses[5:] == [429, 429]


def test_request_rate_limit(harness: Harness) -> None:
    token = harness.token(RECRUITER)
    tags = ["doc_offer_letter", "doc_references", "doc_salary_history"]
    for tag in tags:
        assert harness.call("POST /requests", token, {"tag": tag, "reason": "x"})[0] == 200
    harness.services.requests.decide(f"{RECRUITER}:doc_references", "denied", ADMIN, None)
    assert harness.call("POST /requests", token, {"tag": "doc_references", "reason": "x"})[0] == 429


def test_long_question_rejected(harness: Harness) -> None:
    status, _ = harness.call("POST /chat", harness.token(RECRUITER), {"question": "x" * 1001})
    assert status == 400


def test_unanswerable_question_gets_the_same_reply_as_no_access(harness: Harness) -> None:
    harness.model.reply = "NO_ANSWER"
    status, body = harness.call("POST /chat", harness.token(RECRUITER), {"question": "salary?"})
    assert status == 200
    assert body["citations"] == []
    assert body["answer"].startswith("You do not have access")
    assert "Request access" in body["answer"]


def test_only_cited_titles_are_listed_as_sources(harness: Harness) -> None:
    harness.model.reply = "He studied at Stony Brook [Resume]. See also [Tax return]."
    _, body = harness.call("POST /chat", harness.token(RECRUITER), {"question": "education"})
    assert body["citations"] == ["Resume"]  # an invented title is dropped

    harness.model.reply = "He studied at Stony Brook."
    _, body = harness.call("POST /chat", harness.token(RECRUITER), {"question": "education"})
    assert body["citations"] == []
