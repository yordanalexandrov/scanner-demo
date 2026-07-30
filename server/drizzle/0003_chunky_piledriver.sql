DROP INDEX `attempts_captureGroupId_idx`;--> statement-breakpoint
CREATE INDEX `attempts_captureGroupId_expiryDate_idx` ON `attempts` (`captureGroupId`,`expiryDate`);--> statement-breakpoint
CREATE INDEX `images_source_createdAt_id_idx` ON `images` (`source`,`createdAt`,`id`);--> statement-breakpoint
CREATE INDEX `images_variant_createdAt_id_idx` ON `images` (`variant`,`createdAt`,`id`);