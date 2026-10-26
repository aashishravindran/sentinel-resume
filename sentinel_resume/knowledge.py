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


def chunk_text(text: str, max_chars: int = 800, title: str | None = None) -> list[str]:
    """Section-aligned chunks, each prefixed with the document title and its section heading.

    A chunk like "- Stony Brook University ..." embeds poorly on its own; carrying
    "Resume > Education" lets a question about education find it. Pass `title` to replace the
    document's own heading, e.g. so "0001. Fail closed" says which project's ADR it is.
    """
    doc_title, sections = "", [("", [])]
    in_fence = False
    for line in text.splitlines():
        if line.lstrip().startswith("```"):
            in_fence = not in_fence
        if not in_fence and line.startswith("# ") and not doc_title:
            doc_title = line[2:].strip()
        elif not in_fence and line.startswith("## "):
            sections.append((line[3:].strip(), []))
        else:
            sections[-1][1].append(line)
    title = title or doc_title

    chunks: list[str] = []
    for heading, lines in sections:
        prefix = " > ".join(p for p in (title, heading) if p)
        body = "\n".join(lines).strip()
        if not body:
            continue
        current = ""
        for line in body.splitlines():
            if current and len(current) + len(line) + 1 > max_chars:
                chunks.append(f"{prefix}\n\n{current.strip()}" if prefix else current.strip())
                current = ""
            current += line + "\n"
        if current.strip():
            chunks.append(f"{prefix}\n\n{current.strip()}" if prefix else current.strip())
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
        heading: str | None = None,
    ) -> None:
        """`heading` replaces the document's own title in every chunk's prefix (see chunk_text)."""
        doc = {**(metadata or {}), "doc_id": validate_doc_id(doc_id)}
        stamped = stamp_metadata(access_tags, doc)
        await asyncio.to_thread(self._ingest, text, stamped, doc_id, heading)

    def _ingest(
        self, text: str, stamped: dict[str, MetadataValue], doc_id: str, heading: str | None
    ) -> None:
        pieces = chunk_text(text, title=heading)
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

    def prune(self, keep: Set[str]) -> list[str]:
        """Delete every vector whose document is not in `keep`; returns the removed doc IDs."""
        stale: list[str] = []
        kwargs: dict[str, Any] = {"vectorBucketName": self.bucket, "indexName": self.index}
        while True:
            page = self.client.list_vectors(**kwargs)
            stale += [
                v["key"] for v in page.get("vectors", []) if v["key"].split("#")[0] not in keep
            ]
            if not page.get("nextToken"):
                break
            kwargs["nextToken"] = page["nextToken"]
        for i in range(0, len(stale), 500):
            self.client.delete_vectors(
                vectorBucketName=self.bucket, indexName=self.index, keys=stale[i : i + 500]
            )
        return sorted({k.split("#")[0] for k in stale})
