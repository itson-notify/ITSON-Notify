-- ITN-50. Review/apply manually; never executed at startup. Requires 002.
-- The migration runner must wrap this entire file in one transaction (no begin/commit here).
-- 002 limits notifications_log.channel to 'log', 'email', 'fcm', 'telegram', but the Web Push
-- channel (notificationChannels.webPushChannel) writes 'web_push'. Without this, every Push
-- row fails with 23514 and the notice stays 'pending' until it runs out of attempts.
-- Repeatable: the constraint is dropped (if present) and recreated with the same name.
-- Existing rows are validated when the constraint is added; all of them already satisfy it.
set local lock_timeout = '5s';

alter table public.notifications_log drop constraint if exists notifications_log_channel_check;
alter table public.notifications_log add constraint notifications_log_channel_check
  check (channel in ('log', 'email', 'fcm', 'telegram', 'web_push'));

-- Rollback (manual, commented). Fails if 'web_push' rows exist: delete or migrate them first.
-- set local lock_timeout = '5s';
-- alter table public.notifications_log drop constraint if exists notifications_log_channel_check;
-- alter table public.notifications_log add constraint notifications_log_channel_check
--   check (channel in ('log', 'email', 'fcm', 'telegram'));

-- Verification (after applying). Expected: the definition includes 'web_push'.
-- select pg_get_constraintdef(oid) from pg_constraint
-- where conrelid = 'public.notifications_log'::regclass and conname = 'notifications_log_channel_check';
