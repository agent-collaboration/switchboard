DROP TABLE `admitted_person_guard`;
--> statement-breakpoint
DROP TABLE `allowed_email`;
--> statement-breakpoint
DROP TABLE `deployment_owner`;
--> statement-breakpoint
DROP TABLE `organization_admission_claim`;
--> statement-breakpoint
CREATE TABLE `invitation` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`email` text NOT NULL,
	`role` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`expiresAt` integer NOT NULL,
	`createdAt` integer NOT NULL,
	`inviterId` text NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`inviterId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);

--> statement-breakpoint
CREATE INDEX `invitation_organizationId_idx` ON `invitation` (`organizationId`);
--> statement-breakpoint
CREATE INDEX `invitation_email_idx` ON `invitation` (`email`);
--> statement-breakpoint
CREATE TABLE `member` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`userId` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);

--> statement-breakpoint
CREATE INDEX `member_organizationId_idx` ON `member` (`organizationId`);
--> statement-breakpoint
CREATE INDEX `member_userId_idx` ON `member` (`userId`);
--> statement-breakpoint
CREATE TABLE `organization` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`logo` text,
	`createdAt` integer NOT NULL,
	`metadata` text,
	`fleetState` text DEFAULT 'settingUp' NOT NULL
);

--> statement-breakpoint
CREATE UNIQUE INDEX `organization_slug_unique` ON `organization` (`slug`);
--> statement-breakpoint
ALTER TABLE `session` ADD `activeOrganizationId` text;
--> statement-breakpoint
ALTER TABLE `sign_in_audit` ADD `organization_id` text;
--> statement-breakpoint
CREATE INDEX `sign_in_audit_organization_id` ON `sign_in_audit` (`organization_id`);
