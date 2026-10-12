-- Simulate the permission boundary found on managed Fly Postgres.
-- The application role may create GrowthOS objects, but it does not own the
-- provider's pg_stat monitoring view and therefore cannot alter or drop it.

-- pgvector is enabled by the database owner, like a provider-side extension
-- approval. The restricted application role cannot create extensions; its
-- schema push only verifies that `vector` already exists.
CREATE EXTENSION IF NOT EXISTS vector;

CREATE ROLE fly_provider NOLOGIN;
CREATE ROLE growthos_app LOGIN PASSWORD 'growthos-parity-password';

GRANT CONNECT ON DATABASE growthos_parity TO growthos_app;
GRANT USAGE, CREATE ON SCHEMA public TO growthos_app;

CREATE VIEW public.pg_stat_monitor AS
SELECT clock_timestamp() AS observed_at, 'provider-managed'::text AS source;

ALTER VIEW public.pg_stat_monitor OWNER TO fly_provider;
GRANT SELECT ON public.pg_stat_monitor TO growthos_app;

