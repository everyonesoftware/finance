-- One replaceable encrypted 365-day aggregate per owner, not per-account daily rows.
CREATE TABLE IF NOT EXISTS net_worth_history_cache (
  user_id text PRIMARY KEY NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  encrypted_data text NOT NULL
);

-- Invalidate in the same transaction as every source write, including future
-- editing/sync paths. A rolled-back import also rolls back its invalidation.
CREATE TRIGGER IF NOT EXISTS history_account_insert AFTER INSERT ON bank_account BEGIN
  DELETE FROM net_worth_history_cache WHERE user_id = NEW.user_id;
END;
CREATE TRIGGER IF NOT EXISTS history_account_update AFTER UPDATE ON bank_account BEGIN
  DELETE FROM net_worth_history_cache WHERE user_id IN (OLD.user_id, NEW.user_id);
END;
CREATE TRIGGER IF NOT EXISTS history_account_delete AFTER DELETE ON bank_account BEGIN
  DELETE FROM net_worth_history_cache WHERE user_id = OLD.user_id;
END;
CREATE TRIGGER IF NOT EXISTS history_transaction_insert AFTER INSERT ON bank_transaction BEGIN
  DELETE FROM net_worth_history_cache WHERE user_id = NEW.user_id;
END;
CREATE TRIGGER IF NOT EXISTS history_transaction_update AFTER UPDATE ON bank_transaction BEGIN
  DELETE FROM net_worth_history_cache WHERE user_id IN (OLD.user_id, NEW.user_id);
END;
CREATE TRIGGER IF NOT EXISTS history_transaction_delete AFTER DELETE ON bank_transaction BEGIN
  DELETE FROM net_worth_history_cache WHERE user_id = OLD.user_id;
END;
CREATE TRIGGER IF NOT EXISTS history_item_insert AFTER INSERT ON bank_item BEGIN
  DELETE FROM net_worth_history_cache WHERE user_id = NEW.user_id;
END;
CREATE TRIGGER IF NOT EXISTS history_item_update AFTER UPDATE ON bank_item BEGIN
  DELETE FROM net_worth_history_cache WHERE user_id IN (OLD.user_id, NEW.user_id);
END;
CREATE TRIGGER IF NOT EXISTS history_item_delete AFTER DELETE ON bank_item BEGIN
  DELETE FROM net_worth_history_cache WHERE user_id = OLD.user_id;
END;
