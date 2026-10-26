"""Copy design docs from Aashish's public GitHub repos into corpus/library/ and index them.

uv run python -m scripts.sync_library

Run by hand when a project's docs change, then commit the result: deploys ingest exactly what is
in the repo, and never depend on GitHub being reachable. This repo's own design docs (README,
FLOW, DECISIONS, ADRs) are not copied; scripts/ingest_corpus.py reads them in place.

Only public repos, only the files listed below: everything here becomes readable by every
signed-up recruiter.
"""

import fnmatch
import json
import re
import shutil
import subprocess
import urllib.request
from pathlib import Path
from typing import Any

OWNER = "aashishravindran"
ROOT = Path(__file__).parent.parent
LIBRARY = ROOT / "corpus" / "library"
MANIFEST = ROOT / "corpus" / "library.json"

# repo -> (project name used in titles, file patterns)
SOURCES: dict[str, tuple[str, list[str]]] = {
    "Sentinel": (
        "Sentinel",
        [
            "README.md",
            "RESULTS.md",
            "CONNECTORS.md",
            "docs/adr/0*.md",
            "docs/threat-model.md",
            "docs/benchmarks.md",
            "infra/cdk/README.md",
        ],
    ),
    "sentinel-engine": ("sentinel-engine", ["README.md"]),
    "ProductionRAG": ("ProductionRAG", ["README.md", "ARCHITECTURE.md", "RESEARCH_VALIDATION.md"]),
    "super-duper-chat-bot": ("Super Duper Chat Bot", ["README.md", "ARCHITECTURE.md"]),
    "VISION": ("VISION", ["README.md"]),
    "agentic-fitness-app": (
        "Agentic Fitness App",
        [
            "README.md",
            "docs/ARCHITECTURE.md",
            "docs/HIERARCHICAL_SYSTEM.md",
            "docs/FITNESS_RAG_SPEC.md",
            "docs/persistence_spec.md",
        ],
    ),
    "SuperSetUI": ("SuperSetUI", ["README.md"]),
    "AiAgents": ("AiAgents", ["README.md"]),
    "steal-my-agents": ("steal-my-agents", ["README.md"]),
    "aashishravindran": ("GitHub profile", ["README.md"]),
}


def _token() -> str | None:
    try:
        return subprocess.run(
            ["gh", "auth", "token"], capture_output=True, text=True, check=True
        ).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return None


def _get(url: str, token: str | None, raw: bool = False) -> Any:
    request = urllib.request.Request(url)
    if token:
        request.add_header("Authorization", f"Bearer {token}")
    if raw:
        request.add_header("Accept", "application/vnd.github.raw")
    with urllib.request.urlopen(request, timeout=30) as response:
        body = response.read()
    return body.decode() if raw else json.loads(body)


def doc_title(project: str, path: str, text: str) -> str:
    """'Sentinel ADR 0002: Fail closed', 'VISION: README', 'Sentinel: Threat model'."""
    heading = next((line[2:].strip() for line in text.splitlines() if line.startswith("# ")), "")
    adr = re.match(r"(?:docs/adr/)(\d{4})", path)
    if adr:
        name = re.sub(r"^(ADR[\s-]*)?\d{4}[.:\s-]*", "", heading).strip()
        return f"{project} ADR {adr.group(1)}: {name}"
    if Path(path).name == "README.md":
        return (
            f"{project}: README"
            if path == "README.md"
            else f"{project}: {Path(path).parent} README"
        )
    # "ProductionRAG — Architecture" under project "ProductionRAG" -> "Architecture".
    heading = re.sub(rf"^{re.escape(project)}\s*(RAG\s*)?[—:-]\s*", "", heading, flags=re.I)
    return f"{project}: {heading or Path(path).stem}"


def doc_id(repo: str, path: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9]+", "-", f"{repo}-{path.removesuffix('.md')}").strip("-").lower()
    return f"lib-{slug}"[:128]


def main() -> None:
    token = _token()
    if LIBRARY.exists():
        shutil.rmtree(LIBRARY)
    entries = []
    for repo, (project, patterns) in SOURCES.items():
        meta = _get(f"https://api.github.com/repos/{OWNER}/{repo}", token)
        if meta["private"]:
            raise SystemExit(f"{repo} is private; the library only takes public repos")
        branch = meta["default_branch"]
        tree = _get(
            f"https://api.github.com/repos/{OWNER}/{repo}/git/trees/{branch}?recursive=1", token
        )
        paths = sorted(
            t["path"]
            for t in tree["tree"]
            if t["type"] == "blob" and any(fnmatch.fnmatch(t["path"], p) for p in patterns)
        )
        for path in paths:
            text = _get(
                f"https://api.github.com/repos/{OWNER}/{repo}/contents/{path}?ref={branch}",
                token,
                raw=True,
            )
            dest = LIBRARY / repo / path
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_text(text)
            entries.append(
                {
                    "doc_id": doc_id(repo, path),
                    "title": doc_title(project, path, text),
                    "file": str(dest.relative_to(ROOT)),
                    "source": f"https://github.com/{OWNER}/{repo}/blob/{branch}/{path}",
                }
            )
            print(f"{entries[-1]['doc_id']:<55} {entries[-1]['title']}")
    MANIFEST.write_text(json.dumps({"documents": entries}, indent=2) + "\n")
    print(f"{len(entries)} documents -> {MANIFEST.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
