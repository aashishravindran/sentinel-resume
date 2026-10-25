"""Embed corpus/ into the S3 Vectors index, each document stamped with its catalog tag.

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

CORPUS = Path(__file__).parent.parent / "corpus"


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


if __name__ == "__main__":
    main()
