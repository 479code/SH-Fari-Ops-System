-- Remove multi-tenancy: return to a single-company system.
--
-- Undoes 0001_multi_tenancy (which stays in the history because it has
-- already run in production). Written by hand from the drizzle-kit diff,
-- reordered so MySQL/MariaDB accepts it: foreign keys are dropped before the
-- indexes they rely on, columns before the table they point at.

-- 1. Retire the Platform Administrator role without locking anyone out:
--    anyone holding it is given System Administrator first.
INSERT IGNORE INTO `user_roles` (`user_id`, `role_id`)
SELECT ur.`user_id`, sa.`id`
FROM `user_roles` ur
JOIN `roles` pa ON pa.`id` = ur.`role_id` AND pa.`name` = 'Platform Administrator'
JOIN `roles` sa ON sa.`name` = 'System Administrator';--> statement-breakpoint
DELETE ur FROM `user_roles` ur JOIN `roles` r ON r.`id` = ur.`role_id` WHERE r.`name` = 'Platform Administrator';--> statement-breakpoint
DELETE rp FROM `role_permissions` rp JOIN `roles` r ON r.`id` = rp.`role_id` WHERE r.`name` = 'Platform Administrator';--> statement-breakpoint
DELETE FROM `roles` WHERE `name` = 'Platform Administrator';--> statement-breakpoint
DELETE rp FROM `role_permissions` rp JOIN `permissions` p ON p.`id` = rp.`permission_id` WHERE p.`code` IN ('companies.view', 'companies.manage');--> statement-breakpoint
DELETE FROM `permissions` WHERE `code` IN ('companies.view', 'companies.manage');--> statement-breakpoint

-- 2. Foreign keys to companies first (they hold on to the indexes below).
ALTER TABLE `stations` DROP FOREIGN KEY `stations_company_id_companies_id_fk`;--> statement-breakpoint
ALTER TABLE `users` DROP FOREIGN KEY `users_company_id_companies_id_fk`;--> statement-breakpoint

-- 3. Company-scoped indexes.
ALTER TABLE `stations` DROP INDEX `stations_company_code_uq`;--> statement-breakpoint
ALTER TABLE `stations` DROP INDEX `stations_company_name_uq`;--> statement-breakpoint
DROP INDEX `users_company_idx` ON `users`;--> statement-breakpoint

-- 4. The columns multi-tenancy added.
ALTER TABLE `stations` DROP COLUMN `company_id`;--> statement-breakpoint
ALTER TABLE `stations` DROP COLUMN `photo_url`;--> statement-breakpoint
ALTER TABLE `users` DROP COLUMN `company_id`;--> statement-breakpoint

-- 5. Station code and name are unique across the whole system again.
ALTER TABLE `stations` ADD CONSTRAINT `stations_code_unique` UNIQUE(`code`);--> statement-breakpoint
ALTER TABLE `stations` ADD CONSTRAINT `stations_name_unique` UNIQUE(`name`);--> statement-breakpoint

-- 6. Finally the companies table itself.
DROP TABLE `companies`;
