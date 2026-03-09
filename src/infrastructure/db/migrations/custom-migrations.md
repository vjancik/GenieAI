# Custom Migrations
- To be created with `drizzle-kit generate --custom --name=<name>` after `drizzle-kit generate` is run when recreating migrations

## Custom Migration #1
Name: `stale_cleanup_trigger`

SQL File
```sql
-- Trigger: automatically remove stale gemini_file_uploads rows before each INSERT.
--
-- Gemini Files API files expire 48 hours after upload. This trigger fires once
-- per INSERT statement (BEFORE INSERT FOR EACH STATEMENT) and deletes all rows
-- whose uploaded_at timestamp is older than 48 hours.
--
-- The FOR EACH STATEMENT granularity means the cleanup runs once per batch,
-- not once per row, keeping overhead minimal even for bulk inserts.
--
-- The uploaded_at index (gemini_file_uploads_uploaded_at_idx) created in migration
-- 0000 ensures this DELETE is efficient (index scan rather than seq scan).

CREATE OR REPLACE FUNCTION cleanup_stale_gemini_uploads()
RETURNS TRIGGER AS $$
BEGIN
    DELETE FROM gemini_file_uploads
    WHERE uploaded_at < NOW() - INTERVAL '48 hours';
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER gemini_file_uploads_stale_cleanup
    BEFORE INSERT ON gemini_file_uploads
    FOR EACH STATEMENT
    EXECUTE FUNCTION cleanup_stale_gemini_uploads();
``` 