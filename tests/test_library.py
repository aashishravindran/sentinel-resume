import re
from pathlib import Path

from sentinel_engine.ingest.stamp import validate_doc_id

from sentinel_resume.catalog import load_catalog
from sentinel_resume.knowledge import MAX_CHUNKS_PER_DOC, chunk_text
from sentinel_resume.library import library

ROOT = Path(__file__).parent.parent


def test_library_docs_exist_and_fit_the_index() -> None:
    docs = library(ROOT)
    assert any(d.doc_id == "lib-self-flow" for d in docs)
    assert any(d.title.startswith("Resume assistant (sentinel-resume) ADR 0012") for d in docs)
    assert any(d.title.startswith("Sentinel ADR 0001") for d in docs)
    for d in docs:
        validate_doc_id(d.doc_id)
        text = (ROOT / d.file).read_text()
        assert 0 < len(chunk_text(text, title=d.title)) <= MAX_CHUNKS_PER_DOC, d.file


def test_ids_and_titles_are_unique_and_never_collide_with_the_catalog() -> None:
    docs = library(ROOT)
    ids = [d.doc_id for d in docs] + [d.doc_id for d in load_catalog()]
    assert len(ids) == len(set(ids))
    assert len({d.title for d in docs}) == len(docs)


def test_public_docs_never_quote_a_restricted_document() -> None:
    """The library is public: no design doc may carry a figure or name from a restricted doc."""
    restricted = [ROOT / "corpus" / d.file for d in load_catalog() if d.tag != "public"]
    secrets = set()
    for path in restricted:
        # Dollar figures, SSN-like numbers and the reference names in the synthetic documents.
        secrets |= set(
            re.findall(r"\$[\d,]{5,}|\d{3}-\d{2}-\d{4}|[A-Z][a-z]+ Example", path.read_text())
        )
    assert secrets
    for d in library(ROOT):
        assert not d.file.startswith("corpus/synthetic")
        text = (ROOT / d.file).read_text()
        assert not [s for s in secrets if s in text], d.file
