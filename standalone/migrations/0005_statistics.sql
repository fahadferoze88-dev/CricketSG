-- Only sanitized, precomputed public JSON is published here. Source manifests stay private.
CREATE TABLE public_statistics (
  name TEXT PRIMARY KEY CHECK(name IN ('review', 'primary')),
  generation INTEGER NOT NULL CHECK(typeof(generation) = 'integer' AND generation > 0 AND generation <= 9007199254740991),
  generated_at TEXT NOT NULL CHECK(julianday(generated_at) IS NOT NULL),
  sha256 TEXT NOT NULL CHECK(length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  gzip_base64 TEXT NOT NULL CHECK(
    typeof(gzip_base64) = 'text' AND length(gzip_base64) BETWEEN 28 AND 1800000
    AND length(gzip_base64) % 4 = 0 AND gzip_base64 NOT GLOB '*[^A-Za-z0-9+/=]*'
  ),
  source_manifest TEXT NOT NULL CHECK(
    typeof(source_manifest) = 'text' AND length(CAST(source_manifest AS BLOB)) <= 65536
    AND json_valid(source_manifest) AND json_type(source_manifest) = 'object'
  )
);

-- The publisher additionally compares the expected previous generation/hash in its UPDATE.
-- Publish data and metadata together in one statement; retries must never roll a row backwards.
CREATE TRIGGER public_statistics_monotonic BEFORE UPDATE ON public_statistics
WHEN NEW.name != OLD.name OR NEW.generation <= OLD.generation
BEGIN SELECT RAISE(ABORT, 'Statistics publication generation must increase'); END;
