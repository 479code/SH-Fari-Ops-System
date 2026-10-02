-- Multi-tenancy: companies (tenants), stations/users scoped to a company.
--
-- Written by hand from the drizzle-kit-generated diff, reordered so it is
-- safe to run against a database that already has real stations/users:
-- the new `company_id` columns are added NULLABLE, backfilled onto a
-- seeded default company, and only then tightened to NOT NULL + FKs.
-- Running drizzle-kit generate again after this is applied will see no
-- further diff (the end state matches the schema in src/db/schema).

-- 1. The companies (tenants) table.
CREATE TABLE `companies` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`code` varchar(10) NOT NULL,
	`name` varchar(120) NOT NULL,
	`logo_url` varchar(255),
	`status` enum('active','inactive') NOT NULL DEFAULT 'active',
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `companies_id` PRIMARY KEY(`id`),
	CONSTRAINT `companies_code_unique` UNIQUE(`code`),
	CONSTRAINT `companies_name_unique` UNIQUE(`name`)
);
--> statement-breakpoint

-- 2. Seed the default company that every existing station/user migrates into.
INSERT INTO `companies` (`code`, `name`, `status`) VALUES ('SHFARI', 'SH Fari', 'active');
--> statement-breakpoint

-- 3. Add the new columns nullable first (an ADD ... NOT NULL with no default
--    fails outright once `stations`/`users` already hold rows), and drop the
--    old globally-unique constraints that company-scoping replaces.
ALTER TABLE `stations` DROP INDEX `stations_code_unique`;--> statement-breakpoint
ALTER TABLE `stations` DROP INDEX `stations_name_unique`;--> statement-breakpoint
ALTER TABLE `stations` ADD `company_id` int unsigned;--> statement-breakpoint
ALTER TABLE `stations` ADD `photo_url` varchar(255);--> statement-breakpoint
ALTER TABLE `users` ADD `company_id` int unsigned;--> statement-breakpoint

-- 4. Backfill: every station and every existing user (including the ones
--    that will become the platform super-admin) starts out attached to the
--    seeded company — nobody is left dangling with company_id NULL by
--    accident. See the end of this file for how to promote an account to
--    platform super-admin afterward.
UPDATE `stations` SET `company_id` = (SELECT `id` FROM `companies` WHERE `code` = 'SHFARI');--> statement-breakpoint
UPDATE `users` SET `company_id` = (SELECT `id` FROM `companies` WHERE `code` = 'SHFARI');--> statement-breakpoint

-- 5. Now that every row has a value, enforce NOT NULL (stations only —
--    users.company_id stays nullable; NULL is what marks the platform
--    super-admin) and add the real constraints/indexes.
ALTER TABLE `stations` MODIFY `company_id` int unsigned NOT NULL;--> statement-breakpoint
ALTER TABLE `stations` ADD CONSTRAINT `stations_company_code_uq` UNIQUE(`company_id`,`code`);--> statement-breakpoint
ALTER TABLE `stations` ADD CONSTRAINT `stations_company_name_uq` UNIQUE(`company_id`,`name`);--> statement-breakpoint
ALTER TABLE `stations` ADD CONSTRAINT `stations_company_id_companies_id_fk` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `users` ADD CONSTRAINT `users_company_id_companies_id_fk` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `users_company_idx` ON `users` (`company_id`);

-- ---------------------------------------------------------------------------
-- MANUAL FOLLOW-UP (run once, after this migration, by hand):
--
--   UPDATE users SET company_id = NULL WHERE username = '<your admin username>';
--
-- That is what makes an account the platform super-admin (sees every
-- company). Nobody is set to NULL automatically — you choose who.
-- ---------------------------------------------------------------------------
