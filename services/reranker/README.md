# Grace reranker sidecar

Small CPU-only cross-encoder used by `HybridRagService` (`services/api/src/rag/hybrid-rag.service.ts`)
to re-score candidate RAG passages.

## Run locally

```bash
docker compose up reranker
# health check
curl http://localhost:8081/health
# manual rerank
curl -X POST http://localhost:8081/rerank \
  -H 'content-type: application/json' \
  -d '{"query":"protein on ozempic","documents":["Aim for 1.2-1.6g/kg protein.","Sunsets are pretty."]}'
```

## Wire into the API

Set this env var on the API process (Docker Compose injects it automatically):

```
RERANKER_URL=http://reranker:8081
```

If `RERANKER_URL` is **unset**, the API silently keeps using dense-only RAG —
no behavior change. Setting it opts in.

## Model

Default: `cross-encoder/ms-marco-MiniLM-L-6-v2` (~80 MB, ~10 ms/query CPU).
Override via build arg or env: `RERANKER_MODEL=BAAI/bge-reranker-base`.
