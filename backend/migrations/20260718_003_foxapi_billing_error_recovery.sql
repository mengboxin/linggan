UPDATE user_api_credentials
SET
    status = 'active',
    last_error = NULL,
    updated_at = NOW()
WHERE status = 'invalid'
  AND last_error IS NOT NULL
  AND (
      LOWER(last_error) LIKE '%insufficient balance%'
      OR LOWER(last_error) LIKE '%billing_error%'
      OR LOWER(last_error) LIKE '%insufficient_quota%'
      OR LOWER(last_error) LIKE '%quota_exceeded%'
      OR LOWER(last_error) LIKE '%account balance%'
      OR LOWER(last_error) LIKE '%payment required%'
      OR last_error LIKE '%余额不足%'
  );
