"""The published list of documents. Recruiters request access from here, never from search hints."""

import json
from dataclasses import dataclass
from pathlib import Path

CATALOG_PATH = Path(__file__).with_name("catalog.json")


@dataclass(frozen=True)
class Doc:
    doc_id: str
    title: str
    description: str
    tag: str
    requestable: bool
    file: str


def load_catalog(path: Path = CATALOG_PATH) -> list[Doc]:
    return [Doc(**d) for d in json.loads(path.read_text())["documents"]]


def requestable_tags(catalog: list[Doc]) -> dict[str, Doc]:
    """Tags a recruiter may ask for, each naming exactly one document."""
    return {d.tag: d for d in catalog if d.requestable}


def restricted_tags(catalog: list[Doc]) -> set[str]:
    """Every per-document tag: the admin holds all of them."""
    return {d.tag for d in catalog if d.tag != "public"}
