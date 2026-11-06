ALTER TABLE chat_sessions ADD COLUMN codex_context_version VARCHAR(64) NULL AFTER codex_thread_id;
