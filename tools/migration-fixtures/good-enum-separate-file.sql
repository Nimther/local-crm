-- GSD 08-05 linter fixture — NOT a real migration, never applied to any database.
-- Clean counterpart: the enum value is added and nothing else. Any code that
-- uses 'reconciling' must ship in a LATER migration, after this one is applied.
ALTER TYPE "send_status" ADD VALUE 'reconciling';
