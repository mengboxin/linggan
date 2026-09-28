-- Intentionally startup-safe. Clearing legacy expiry values can touch a large
-- number of rows and must not hold one application-startup transaction open.
-- Run the auto-commit, SKIP LOCKED batch job before enabling any expiry cleanup:
--
--   python backend/scripts/maintenance/clear_web_history_expiry.py
--
-- The application already assigns no expiry to newly stored web-history assets;
-- this maintenance job reconciles only pre-existing rows.
SELECT 1;
