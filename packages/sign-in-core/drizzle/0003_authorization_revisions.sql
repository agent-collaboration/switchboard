CREATE TABLE `organization_authorization_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`revision` integer NOT NULL,
	`state` text NOT NULL,
	`permission_policy_digest` text NOT NULL,
	`acknowledged_revision` integer DEFAULT 0 NOT NULL,
	`acknowledged_at` integer,
	`next_attempt_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "organization_revision_range" CHECK("organization_authorization_revisions"."revision" between 1 and 9007199254740991),
	CONSTRAINT "organization_revision_state" CHECK("organization_authorization_revisions"."state" in ('active', 'stopped', 'deleted')),
	CONSTRAINT "organization_ack_range" CHECK("organization_authorization_revisions"."acknowledged_revision" between 0 and "organization_authorization_revisions"."revision")
);
--> statement-breakpoint
CREATE TABLE `person_organization_authorization_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`person_id` text NOT NULL,
	`revision` integer NOT NULL,
	`state` text NOT NULL,
	`acknowledged_revision` integer DEFAULT 0 NOT NULL,
	`acknowledged_at` integer,
	`next_attempt_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "person_revision_range" CHECK("person_organization_authorization_revisions"."revision" between 1 and 9007199254740991),
	CONSTRAINT "person_revision_state" CHECK("person_organization_authorization_revisions"."state" in ('active', 'inactive')),
	CONSTRAINT "person_ack_range" CHECK("person_organization_authorization_revisions"."acknowledged_revision" between 0 and "person_organization_authorization_revisions"."revision")
);
--> statement-breakpoint
CREATE INDEX `person_authorization_subjects` ON `person_organization_authorization_revisions` (`person_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `person_authorization_pair` ON `person_organization_authorization_revisions` (`organization_id`,`person_id`);