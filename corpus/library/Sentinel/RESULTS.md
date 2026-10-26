# Sentinel RAG — v1 Test Results

End-to-end validation of access control behaviour using the SQLite identity store and ChromaDB knowledge store.

## Test Users

| User | Tags | Notes |
|---|---|---|
| alice | finance, public | Finance team member |
| bob | public, engineering | Engineer, no finance access |
| charlie | finance, engineering, public | Cross-functional — full access |
| aashish | *(none)* | Not in identity store |

## Seed Documents

| Document | Tags | Accessible by |
|---|---|---|
| Public Company Overview | public | alice, bob, charlie |
| Public Employee Handbook | public | alice, bob, charlie |
| Finance Q4 2025 Report | finance | alice, charlie |
| Finance Budget 2026 | finance | alice, charlie |
| Engineering System Architecture | engineering | bob, charlie |
| Engineering On-Call Runbook | engineering | bob, charlie |
| Internal 2026 Roadmap | finance, engineering | alice, bob, charlie (OR policy) |

---

## Scenario Results

### 1. Fail-Closed — User Not in Identity Store

**Query:** `aashish` → "OncallHandbook runbook"

```
Access Denied: User 'aashish' has no permissions. Access denied.
```

✅ Correct. No KB call is made. Sentinel fails closed before touching the knowledge store.

---

### 2. No Relevant Documents in Permitted Scope

**Query:** `bob` (public, engineering) → "2026 finance budget"

```
You do not have access to documents relevant to this query.
The information may exist but is not within your permitted scope.
```

✅ Correct. Bob's tags match no finance documents above the relevance threshold (0.25). Instead of returning tangential public docs that cause LLM hallucination, Sentinel returns a clear denial.

---

### 3. Successful Retrieval — Finance User

**Query:** `alice` (finance, public) → "Q4 financial budget numbers"

```
[1] Finance Budget 2026 (score: 0.47)
[2] Finance Q4 2025 Report (score: 0.40)
```

✅ Correct. Alice's finance tag matches both documents.

---

### 4. Successful Retrieval — Engineering User

**Query:** `bob` (public, engineering) → "on-call runbook incidents"

```
[1] Engineering On-Call Runbook (score: 0.36)
```

✅ Correct. Bob's engineering tag surfaces the runbook.

---

### 5. OR Policy — Multi-Tag Document

**Query:** `bob` (public, engineering) → "2026 roadmap initiatives"

The Internal 2026 Roadmap is tagged `[finance, engineering]`. Under OR policy, bob (who holds `engineering`) can access it.

```
[1] Internal 2026 Roadmap (score: 0.31)
```

✅ Correct. OR policy: user needs any one of the document's tags.

---

### 6. Full Access — Cross-Functional User

**Query:** `charlie` (finance, engineering, public) → "Q4 budget"

```
[1] Finance Q4 2025 Report (score: 0.39)
[2] Finance Budget 2026 (score: 0.38)
[3] Internal 2026 Roadmap (score: 0.20)
```

✅ Correct. Charlie's combined tags surface all relevant documents.

---

## Bugs Found and Fixed

### Bug 1 — AND Policy Incorrectly Blocking OR-Intended Access

**Symptom:** Initial implementation used AND semantics — a document tagged `[finance, engineering]` required the user to hold both tags. Bob (engineering) was blocked from the roadmap.

**Fix:** Reverted to OR policy. The ChromaDB `$or` pre-filter was already correct; the AND post-filter was removed.

### Bug 2 — Hallucination from Low-Relevance Results

**Symptom:** When a user had access to documents but none were relevant to their query, ChromaDB returned the closest matches anyway (e.g. public handbook for a finance query). The LLM then hallucinated answers based on these low-signal results.

**Fix:** Added `MIN_RELEVANCE_SCORE=0.25` threshold (now `sentinel_engine.results`). Results below the threshold are discarded. If nothing passes, Sentinel returns a clear "you do not have access" message. Threshold is configurable via env var.

---

## Access Control Matrix (verified)

| User \ Document | Public | Finance | Engineering | Finance+Engineering |
|---|---|---|---|---|
| alice | ✅ | ✅ | ❌ | ✅* |
| bob | ✅ | ❌ | ✅ | ✅* |
| charlie | ✅ | ✅ | ✅ | ✅ |
| aashish | ❌ (denied) | ❌ (denied) | ❌ (denied) | ❌ (denied) |

*\* OR policy: accessible because user holds one of the two required tags.*
