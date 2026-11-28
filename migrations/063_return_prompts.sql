-- One-time "your request was returned" prompt for the person who must rework it.
-- Set when that person closes the prompt; the prompt is never shown again for the same return.
ALTER TABLE corrections ADD COLUMN prompt_seen_at timestamptz;
