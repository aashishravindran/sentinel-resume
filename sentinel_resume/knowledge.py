"""S3 Vectors as Sentinel's knowledge store: no cluster, nothing billed while idle.

The caller's scope becomes an S3 Vectors metadata filter, so documents outside
it are never candidates for the similarity search. The engine re-checks every
returned chunk against the scope afterwards.
"""

import asyncio
import json
from collections.abc import Mapping, Set
from typing import Any, Protocol

from sentinel_engine.base import Chunk, KnowledgeConnector, MetadataValue
from sentinel_engine.filters import build_chroma_where
from sentinel_engine.ingest.stamp import stamp_metadata, validate_doc_id

TEXT_KEY = "text"
MAX_CHUNKS_PER_DOC = 100


class Embedder(Protocol):
    def embed(self, text: str) -> list[float]: ...


class TitanEmbedder:
    def __init__(self, bedrock_runtime: Any, model_id: str, dimensions: int = 1024):
        self.client = bedrock_runtime
        self.model_id = model_id
        self.dimensions = dimensions

    def embed(self, text: str) -> list[float]:
        response = self.client.invoke_model(
            modelId=self.model_id,
            contentType="application/json",
            body=json.dumps({"inputText": text, "dimensions": self.dimensions, "normalize": True}),
        )
        return json.loads(response["body"].read())["embedding"]


def build_filter(tags: Set[str]) -> dict[str, Any]:
    """S3 Vectors uses the same $or/$eq filter language as Chroma; empty scope raises."""
    return build_chroma_where(tags)


def chunk_text(text: str, max_chars: int = 800) -> list[str]:
    """Paragraph-aligned chunks, so a sentence is never split across two of them."""
    chunks: list[str] = []
    current = ""
    for para in (p.strip() for p in text.split("\n\n")):
        if not para:
            continue
        if current and len(current) + len(para) + 2 > max_chars:
            chunks.append(current)
            current = ""
        current = f"{current}\n\n{para}" if current else para
    if current:
        chunks.append(current)
    return chunks


def _supports_query_mode(client: Any) -> bool:
    """Pre-filtering gives full recall on narrow scopes; older SDKs lack the parameter."""
    try:
        shape = client.meta.service_model.operation_model("QueryVectors").input_shape
    except AttributeError:
        return False
    return "queryMode" in shape.members


class S3VectorsKnowledge(KnowledgeConnector):
    def __init__(self, client: Any, bucket: str, index: str, embedder: Embedder):
        self.client = client
        self.bucket = bucket
        self.index = index
        self.embedder = embedder
        self._query_mode = {"queryMode": "ENHANCED"} if _supports_query_mode(client) else {}

    async def search(self, query: str, tags: Set[str], n_results: int = 5) -> list[Chunk]:
        vector_filter = build_filter(tags)
        return await asyncio.to_thread(self._search, query, vector_filter, n_results)

    def _search(self, query: str, vector_filter: dict[str, Any], n_results: int) -> list[Chunk]:
        response = self.client.query_vectors(
            vectorBucketName=self.bucket,
            indexName=self.index,
            queryVector={"float32": self.embedder.embed(query)},
            topK=n_results,
            filter=vector_filter,
            returnMetadata=True,
            returnDistance=True,
            **self._query_mode,
        )
        chunks: list[Chunk] = []
        for hit in response.get("vectors", []):
            metadata = dict(hit.get("metadata") or {})
            text = metadata.pop(TEXT_KEY, "")
            # Cosine distance is 0 for identical vectors; report similarity like the other stores.
            score = round(1.0 - float(hit.get("distance", 1.0)), 4)
            chunks.append({"text": str(text), "metadata": metadata, "score": score})
        return chunks

    async def ingest(
        self,
        text: str,
        access_tags: list[str],
        doc_id: str,
        metadata: Mapping[str, MetadataValue] | None = None,
    ) -> None:
        doc = {**(metadata or {}), "doc_id": validate_doc_id(doc_id)}
        stamped = stamp_metadata(access_tags, doc)
        await asyncio.to_thread(self._ingest, text, stamped, doc_id)

    def _ingest(self, text: str, stamped: dict[str, MetadataValue], doc_id: str) -> None:
        pieces = chunk_text(text)
        if len(pieces) > MAX_CHUNKS_PER_DOC:
            raise ValueError(f"{doc_id} has {len(pieces)} chunks; max is {MAX_CHUNKS_PER_DOC}")
        # Replace the whole document, so a shorter revision leaves no stale tail chunks.
        self.client.delete_vectors(
            vectorBucketName=self.bucket,
            indexName=self.index,
            keys=[f"{doc_id}#{i:03d}" for i in range(MAX_CHUNKS_PER_DOC)],
        )
        vectors = [
            {
                "key": f"{doc_id}#{i:03d}",
                "data": {"float32": self.embedder.embed(piece)},
                "metadata": {**stamped, TEXT_KEY: piece},
            }
            for i, piece in enumerate(pieces)
        ]
        self.client.put_vectors(vectorBucketName=self.bucket, indexName=self.index, vectors=vectors)
