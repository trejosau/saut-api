DO $$
BEGIN
  IF to_regclass('public.recovery_codes_account_idx') IS NOT NULL
     AND to_regclass('public.recovery_codes_account_id_used_at_idx') IS NULL THEN
    ALTER INDEX public.recovery_codes_account_idx RENAME TO recovery_codes_account_id_used_at_idx;
  END IF;
END
$$;
