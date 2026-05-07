create or replace function public.match_grace_knowledge(
  query_embedding vector(1536),
  match_count int default 3
)
returns table (
  user_message text,
  grace_response text,
  style_tag text,
  similarity float
)
language sql stable
set search_path = public
as $$
  select
    user_message,
    grace_response,
    style_tag,
    1 - (embedding <=> query_embedding) as similarity
  from grace_knowledge
  where embedding is not null
  order by embedding <=> query_embedding
  limit match_count;
$$;