CREATE TABLE `barcode_scans` (
	`id` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`decodeMs` real NOT NULL,
	`device` text NOT NULL,
	`scannedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `barcode_scans_scannedAt_id_idx` ON `barcode_scans` (`scannedAt`,`id`);