-- The defaults backfill rows written before ADR-21/22. The HTTP schema still requires both fields
-- on every new attempt, so an old APK fails loudly instead of relying on these legacy values.
ALTER TABLE `attempts` ADD `parserVersion` text DEFAULT 'parser-v1' NOT NULL;--> statement-breakpoint
ALTER TABLE `attempts` ADD `timingVersion` text DEFAULT 'shutter-v1' NOT NULL;
