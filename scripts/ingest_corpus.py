"""Embed the corpus into the S3 Vectors index, each document stamped with its access tag.

Catalog documents carry their catalog tag; the design-doc library (sentinel_resume/library.py) is
`public`. Vectors of documents no longer in either list are deleted.

uv run python -m scripts.ingest_corpus [--region us-east-1]
"""

import argparse
import asyncio
from pathlib import Path
from typing import Any

import boto3

from scripts.stack import outputs
from sentinel_resume.catalog import load_catalog
from sentinel_resume.knowledge import S3VectorsKnowledge, TitanEmbedder
from sentinel_resume.library import library

ROOT = Path(__file__).parent.parent
CORPUS = ROOT / "corpus"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--region", default="us-east-1")
    args = parser.parse_args()
    out = outputs(args.region)
    bedrock: Any = boto3.client("bedrock-runtime", region_name=args.region)
    knowledge = S3VectorsKnowledge(
        boto3.client("s3vectors", region_name=args.region),
        out["VectorBucketName"],
        out["VectorIndexName"],
        TitanEmbedder(bedrock, "amazon.titan-embed-text-v2:0"),
    )
    for doc in load_catalog():
        text = (CORPUS / doc.file).read_text()
        asyncio.run(knowledge.ingest(text, [doc.tag], doc.doc_id, {"title": doc.title}))
        print(f"ingested {doc.doc_id:<20} tag={doc.tag}")
    docs = library(ROOT)
    for lib in docs:
        text = (ROOT / lib.file).read_text()
        asyncio.run(
            knowledge.ingest(text, ["public"], lib.doc_id, {"title": lib.title}, heading=lib.title)
        )
    print(f"ingested {len(docs)} library documents, tag=public")
    keep = {d.doc_id for d in load_catalog()} | {d.doc_id for d in docs}
    for removed in knowledge.prune(keep):
        print(f"removed  {removed}")


if __name__ == "__main__":
    main()
