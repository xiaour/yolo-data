-- Persist the Codex app-server thread used by each YOLO chat session.
-- STATEMENT
ALTER TABLE chat_sessions ADD COLUMN codex_thread_id TEXT;
