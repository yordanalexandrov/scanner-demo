CREATE TABLE `attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`imageId` text NOT NULL,
	`captureGroupId` text NOT NULL,
	`method` text NOT NULL,
	`inputVariant` text NOT NULL,
	`engine` text,
	`device` text NOT NULL,
	`expiryDate` text,
	`expiryStatus` text,
	`expiryPrecision` text,
	`parseRule` text,
	`totalMs` real NOT NULL,
	`engineMs` real,
	`costEstimateUsd` real,
	`referenceDate` text NOT NULL,
	`pricingVersion` text NOT NULL,
	`promptVersion` text,
	`error` text,
	`ocrJson` text,
	`parseJson` text,
	`vlmJson` text,
	`timingJson` text NOT NULL,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`imageId`) REFERENCES `images`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `attempts_imageId_createdAt_idx` ON `attempts` (`imageId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `attempts_captureGroupId_idx` ON `attempts` (`captureGroupId`);--> statement-breakpoint
CREATE INDEX `attempts_method_inputVariant_idx` ON `attempts` (`method`,`inputVariant`);--> statement-breakpoint
CREATE INDEX `attempts_expiryDate_idx` ON `attempts` (`expiryDate`);--> statement-breakpoint
CREATE INDEX `attempts_totalMs_idx` ON `attempts` (`totalMs`);