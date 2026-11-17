CREATE TABLE `twoFactor` (
	`id` text PRIMARY KEY NOT NULL,
	`secret` text NOT NULL,
	`backupCodes` text NOT NULL,
	`userId` text NOT NULL,
	`verified` integer DEFAULT true,
	`failedVerificationCount` integer DEFAULT 0,
	`lockedUntil` integer,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);

--> statement-breakpoint
CREATE INDEX `twoFactor_secret_idx` ON `twoFactor` (`secret`);
--> statement-breakpoint
CREATE INDEX `twoFactor_userId_idx` ON `twoFactor` (`userId`);
--> statement-breakpoint
ALTER TABLE `session` ADD `secondFactorAt` integer;
--> statement-breakpoint
ALTER TABLE `session` ADD `secondFactorMethod` text;
--> statement-breakpoint
ALTER TABLE `user` ADD `twoFactorEnabled` integer DEFAULT false;
--> statement-breakpoint
ALTER TABLE `user` ADD `secondFactorSetAt` integer;
