ALTER TABLE `organization` ADD `fleetStampDigest` text;--> statement-breakpoint
ALTER TABLE `organization` ADD `fleetStampExpiresAt` integer;--> statement-breakpoint
ALTER TABLE `organization` ADD `fleetStampSigningKeyId` text;--> statement-breakpoint
ALTER TABLE `organization` ADD `fleetStampSent` text;--> statement-breakpoint
ALTER TABLE `organization` ADD `fleetStampRenewedAt` integer;--> statement-breakpoint
ALTER TABLE `organization` ADD `fleetStampUnansweredTries` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `organization` ADD `fleetStampRefusedTries` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `organization` ADD `fleetStampLastTryAt` integer;--> statement-breakpoint
ALTER TABLE `organization` ADD `fleetStampLastTryOutcome` text;