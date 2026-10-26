"""Public design docs: Aashish's project write-ups, ADRs and flows, readable by every recruiter.

Two sources, both tagged `public`:
- corpus/library.json: docs copied from his public GitHub repos by scripts/sync_library.py.
- This repo's own README, FLOW, DECISIONS and ADRs, read in place so they are never stale.
"""

import json
import re
from dataclasses import dataclass
from pathlib import Path

PROJECT = "Resume assistant (sentinel-resume)"
# Written into the Lambda bundle by scripts/build_lambda.sh; the API lists it on the documents page.
INDEX_PATH = Path(__file__).with_name("library_index.json")
REPO_URL = "https://github.com/aashishravindran/sentinel-resume/blob/master"


@dataclass(frozen=True)
class LibraryDoc:
    doc_id: str
    title: str
    file: str  # relative to the repo root
    source: str

    @property
    def project(self) -> str:
        return re.split(r" ADR \d{4}:|: ", self.title, maxsplit=1)[0]


def _heading(text: str) -> str:
    return next((line[2:].strip() for line in text.splitlines() if line.startswith("# ")), "")


def own_docs(root: Path) -> list[LibraryDoc]:
    docs = [
        LibraryDoc("lib-self-readme", f"{PROJECT}: README", "README.md", f"{REPO_URL}/README.md"),
        LibraryDoc("lib-self-flow", f"{PROJECT}: Flows", "FLOW.md", f"{REPO_URL}/FLOW.md"),
        LibraryDoc(
            "lib-self-decisions",
            f"{PROJECT}: Decisions",
            "DECISIONS.md",
            f"{REPO_URL}/DECISIONS.md",
        ),
    ]
    for path in sorted((root / "docs" / "adr").glob("[0-9][0-9][0-9][0-9]-*.md")):
        number = path.name[:4]
        name = re.sub(r"^\d{4}[.:\s-]*", "", _heading(path.read_text())).strip()
        rel = str(path.relative_to(root))
        docs.append(
            LibraryDoc(
                f"lib-self-adr-{number}",
                f"{PROJECT} ADR {number}: {name}",
                rel,
                f"{REPO_URL}/{rel}",
            )
        )
    return docs


def synced_docs(root: Path) -> list[LibraryDoc]:
    manifest = root / "corpus" / "library.json"
    if not manifest.exists():
        return []
    return [LibraryDoc(**d) for d in json.loads(manifest.read_text())["documents"]]


def library(root: Path) -> list[LibraryDoc]:
    return own_docs(root) + synced_docs(root)


def write_index(root: Path, path: Path) -> None:
    entries = [{"title": d.title, "project": d.project, "source": d.source} for d in library(root)]
    path.write_text(json.dumps(entries, indent=1) + "\n")


def load_index(path: Path = INDEX_PATH) -> list[dict[str, str]]:
    return json.loads(path.read_text()) if path.exists() else []


if __name__ == "__main__":
    import sys

    write_index(Path(__file__).parent.parent, Path(sys.argv[1]))
