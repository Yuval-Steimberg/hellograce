"""
Grace cross-encoder reranker sidecar.

Stateless HTTP service used by the TypeScript HybridRagService to re-score
candidate RAG passages against a query. Uses a small CPU-friendly cross-encoder
so it can run on the same Fly machine class as the API without GPUs.

Contract (matches services/api/src/rag/reranker.service.ts):
  POST /rerank
    body: { "query": "...", "documents": ["...", "..."] }
    resp: { "scores": [float, float, ...] }   # higher = more relevant

  GET /health -> { "ok": true, "model": "..." }
"""

from __future__ import annotations

import os
from typing import List

from fastapi import FastAPI
from pydantic import BaseModel
from sentence_transformers import CrossEncoder

MODEL_NAME = os.environ.get("RERANKER_MODEL", "cross-encoder/ms-marco-MiniLM-L-6-v2")
MAX_DOCS = int(os.environ.get("RERANKER_MAX_DOCS", "32"))

app = FastAPI(title="grace-reranker", version="1.0.0")
model = CrossEncoder(MODEL_NAME, max_length=512)


class RerankRequest(BaseModel):
    query: str
    documents: List[str]


class RerankResponse(BaseModel):
    scores: List[float]


@app.get("/health")
def health() -> dict:
    return {"ok": True, "model": MODEL_NAME}


@app.post("/rerank", response_model=RerankResponse)
def rerank(req: RerankRequest) -> RerankResponse:
    if not req.documents:
        return RerankResponse(scores=[])
    docs = req.documents[:MAX_DOCS]
    pairs = [(req.query, d) for d in docs]
    raw = model.predict(pairs, convert_to_numpy=True)
    scores = [float(s) for s in raw.tolist()]
    if len(scores) < len(req.documents):
        scores.extend([0.0] * (len(req.documents) - len(scores)))
    return RerankResponse(scores=scores)
