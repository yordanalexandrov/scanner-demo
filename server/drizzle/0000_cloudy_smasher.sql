CREATE TABLE `images` (
	`id` text PRIMARY KEY NOT NULL,
	`captureGroupId` text NOT NULL,
	`variant` text NOT NULL,
	`source` text NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`bytes` integer NOT NULL,
	`mimeType` text NOT NULL,
	`torch` integer,
	`captureWidth` integer,
	`captureHeight` integer,
	`downscaled` integer NOT NULL,
	`capturedAt` integer NOT NULL,
	`capturedAtSource` text NOT NULL,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `images_createdAt_id_idx` ON `images` (`createdAt`,`id`);--> statement-breakpoint
CREATE INDEX `images_captureGroupId_idx` ON `images` (`captureGroupId`);--> statement-breakpoint
CREATE INDEX `images_capturedAt_idx` ON `images` (`capturedAt`);