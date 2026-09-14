CREATE TABLE `audit_logs` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`user_id` int unsigned,
	`action` varchar(40) NOT NULL,
	`resource` varchar(40) NOT NULL,
	`resource_id` varchar(40),
	`record_ref` varchar(80),
	`station_id` int unsigned,
	`old_value` json,
	`new_value` json,
	`ip_address` varchar(64),
	`user_agent` varchar(255),
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `audit_logs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `bank_deposits` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`teller_ref` varchar(60) NOT NULL,
	`station_id` int unsigned NOT NULL,
	`bank_id` int unsigned NOT NULL,
	`business_date` date NOT NULL,
	`deposited_at` datetime NOT NULL,
	`amount` decimal(16,2) NOT NULL,
	`status` enum('confirmed','cancelled') NOT NULL DEFAULT 'confirmed',
	`recorded_by` int unsigned NOT NULL,
	`cancelled_by` int unsigned,
	`cancelled_at` datetime,
	`cancel_reason` varchar(255),
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `bank_deposits_id` PRIMARY KEY(`id`),
	CONSTRAINT `bank_deposits_tellerRef_unique` UNIQUE(`teller_ref`)
);
--> statement-breakpoint
CREATE TABLE `banks` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`name` varchar(80) NOT NULL,
	`status` enum('active','inactive') NOT NULL DEFAULT 'active',
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `banks_id` PRIMARY KEY(`id`),
	CONSTRAINT `banks_name_unique` UNIQUE(`name`)
);
--> statement-breakpoint
CREATE TABLE `cash_positions` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`station_id` int unsigned NOT NULL,
	`business_date` date NOT NULL,
	`pos_amount` decimal(16,2) NOT NULL DEFAULT 0,
	`closing_cit` decimal(16,2) NOT NULL DEFAULT 0,
	`cash_at_hand` decimal(16,2) NOT NULL DEFAULT 0,
	`notes` varchar(255),
	`status` enum('open','reviewed','closed') NOT NULL DEFAULT 'open',
	`sales_value` decimal(16,2) NOT NULL DEFAULT 0,
	`credit_sales` decimal(16,2) NOT NULL DEFAULT 0,
	`debtor_cash_receipts` decimal(16,2) NOT NULL DEFAULT 0,
	`cash_expenses` decimal(16,2) NOT NULL DEFAULT 0,
	`expected_cash` decimal(16,2) NOT NULL DEFAULT 0,
	`brought_forward` decimal(16,2) NOT NULL DEFAULT 0,
	`deposits_total` decimal(16,2) NOT NULL DEFAULT 0,
	`variance` decimal(16,2) NOT NULL DEFAULT 0,
	`tolerance` decimal(16,2) NOT NULL DEFAULT 0,
	`tolerance_status` enum('reconciled','within_tolerance','exceeded') NOT NULL DEFAULT 'reconciled',
	`recorded_by` int unsigned NOT NULL,
	`reviewed_by` int unsigned,
	`reviewed_at` datetime,
	`review_comment` varchar(500),
	`closed_by` int unsigned,
	`closed_at` datetime,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `cash_positions_id` PRIMARY KEY(`id`),
	CONSTRAINT `cash_positions_station_date_uq` UNIQUE(`station_id`,`business_date`)
);
--> statement-breakpoint
CREATE TABLE `debtor_transactions` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`debtor_id` int unsigned NOT NULL,
	`station_id` int unsigned NOT NULL,
	`type` enum('opening_balance','credit_sale','repayment') NOT NULL,
	`amount` decimal(16,2) NOT NULL,
	`business_date` date NOT NULL,
	`reference` varchar(60),
	`payment_method` enum('cash','transfer','pos'),
	`note` varchar(255),
	`recorded_by` int unsigned NOT NULL,
	`voided_at` datetime,
	`voided_by` int unsigned,
	`void_reason` varchar(255),
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `debtor_transactions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `debtors` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`station_id` int unsigned NOT NULL,
	`name` varchar(160) NOT NULL,
	`phone` varchar(30),
	`credit_limit` decimal(16,2),
	`status` enum('active','inactive') NOT NULL DEFAULT 'active',
	`created_by` int unsigned NOT NULL,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `debtors_id` PRIMARY KEY(`id`),
	CONSTRAINT `debtors_station_name_uq` UNIQUE(`station_id`,`name`)
);
--> statement-breakpoint
CREATE TABLE `dsr_days` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`ref` varchar(40) NOT NULL,
	`station_id` int unsigned NOT NULL,
	`business_date` date NOT NULL,
	`status` enum('open','closed') NOT NULL DEFAULT 'open',
	`opened_by` int unsigned NOT NULL,
	`opened_at` datetime NOT NULL,
	`closed_by` int unsigned,
	`closed_at` datetime,
	`reopen_count` int unsigned NOT NULL DEFAULT 0,
	`last_reopened_by` int unsigned,
	`last_reopened_at` datetime,
	`last_reopen_reason` varchar(255),
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `dsr_days_id` PRIMARY KEY(`id`),
	CONSTRAINT `dsr_days_ref_unique` UNIQUE(`ref`),
	CONSTRAINT `dsr_days_station_date_uq` UNIQUE(`station_id`,`business_date`)
);
--> statement-breakpoint
CREATE TABLE `dsr_readings` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`dsr_day_id` int unsigned NOT NULL,
	`pump_id` int unsigned NOT NULL,
	`tank_id` int unsigned NOT NULL,
	`product_id` int unsigned NOT NULL,
	`opening_reading` decimal(14,2) NOT NULL,
	`closing_reading` decimal(14,2),
	`dispensed_litres` decimal(14,2),
	`rtt_litres` decimal(14,2),
	`net_sales_litres` decimal(14,2),
	`unit_price` decimal(12,2),
	`unit_cost` decimal(12,2),
	`sales_value` decimal(16,2),
	`cost_value` decimal(16,2),
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `dsr_readings_id` PRIMARY KEY(`id`),
	CONSTRAINT `dsr_readings_day_pump_uq` UNIQUE(`dsr_day_id`,`pump_id`)
);
--> statement-breakpoint
CREATE TABLE `exceptions` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`type` enum('cash_variance','stock_variance','git_delay','git_shortage','git_exception','debtor_aging') NOT NULL,
	`severity` enum('high','medium') NOT NULL,
	`station_id` int unsigned,
	`source_type` varchar(40) NOT NULL,
	`source_id` int unsigned NOT NULL,
	`source_ref` varchar(60) NOT NULL,
	`title` varchar(255) NOT NULL,
	`detail` varchar(500),
	`amount` decimal(16,2),
	`status` enum('open','reviewed','closed') NOT NULL DEFAULT 'open',
	`raised_at` datetime NOT NULL,
	`reviewed_by` int unsigned,
	`reviewed_at` datetime,
	`review_comment` varchar(500),
	`closed_by` int unsigned,
	`closed_at` datetime,
	`resolution` varchar(500),
	`updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `exceptions_id` PRIMARY KEY(`id`),
	CONSTRAINT `exceptions_source_uq` UNIQUE(`type`,`source_type`,`source_id`)
);
--> statement-breakpoint
CREATE TABLE `expense_narrations` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`name` varchar(80) NOT NULL,
	`approval_threshold` decimal(16,2),
	`status` enum('active','inactive') NOT NULL DEFAULT 'active',
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `expense_narrations_id` PRIMARY KEY(`id`),
	CONSTRAINT `expense_narrations_name_unique` UNIQUE(`name`)
);
--> statement-breakpoint
CREATE TABLE `expenses` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`ref` varchar(20) NOT NULL,
	`station_id` int unsigned NOT NULL,
	`narration_id` int unsigned NOT NULL,
	`business_date` date NOT NULL,
	`amount` decimal(16,2) NOT NULL,
	`payee` varchar(120) NOT NULL,
	`reference` varchar(60),
	`note` varchar(255),
	`payment_method` enum('cash','transfer') NOT NULL DEFAULT 'cash',
	`status` enum('pending','approved','rejected','cancelled') NOT NULL,
	`approval_threshold` decimal(16,2),
	`decided_by` int unsigned,
	`decided_at` datetime,
	`decision_note` varchar(255),
	`recorded_by` int unsigned NOT NULL,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `expenses_id` PRIMARY KEY(`id`),
	CONSTRAINT `expenses_ref_unique` UNIQUE(`ref`)
);
--> statement-breakpoint
CREATE TABLE `git_deliveries` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`git_order_id` int unsigned NOT NULL,
	`station_id` int unsigned NOT NULL,
	`planned_quantity` decimal(14,2) NOT NULL,
	`discharged_quantity` decimal(14,2) NOT NULL DEFAULT 0,
	`status` enum('pending','discharged','cancelled') NOT NULL DEFAULT 'pending',
	`discharged_at` datetime,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `git_deliveries_id` PRIMARY KEY(`id`),
	CONSTRAINT `git_deliveries_order_station_uq` UNIQUE(`git_order_id`,`station_id`)
);
--> statement-breakpoint
CREATE TABLE `git_events` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`git_order_id` int unsigned NOT NULL,
	`event_type` varchar(40) NOT NULL,
	`from_status` varchar(30),
	`to_status` varchar(30),
	`note` varchar(255),
	`user_id` int unsigned,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `git_events_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `git_orders` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`ref` varchar(20) NOT NULL,
	`product_id` int unsigned NOT NULL,
	`quantity` decimal(14,2) NOT NULL,
	`order_price` decimal(12,2) NOT NULL,
	`truck_id` int unsigned,
	`is_multi_delivery` boolean NOT NULL DEFAULT false,
	`source` varchar(120),
	`status` enum('order_created','truck_assigned','in_transit','arrived','discharging','completed','cancelled') NOT NULL DEFAULT 'order_created',
	`order_date` date NOT NULL,
	`expected_arrival_date` date,
	`truck_assigned_at` datetime,
	`in_transit_at` datetime,
	`arrived_at` datetime,
	`discharge_started_at` datetime,
	`completed_at` datetime,
	`cancelled_at` datetime,
	`cancel_reason` varchar(255),
	`exception_type` enum('shortage','delay','price','other'),
	`exception_note` varchar(255),
	`notes` varchar(255),
	`created_by` int unsigned NOT NULL,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `git_orders_id` PRIMARY KEY(`id`),
	CONSTRAINT `git_orders_ref_unique` UNIQUE(`ref`)
);
--> statement-breakpoint
CREATE TABLE `password_reset_tokens` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`user_id` int unsigned NOT NULL,
	`token_hash` varchar(64) NOT NULL,
	`expires_at` datetime NOT NULL,
	`used_at` datetime,
	`created_by` int unsigned,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `password_reset_tokens_id` PRIMARY KEY(`id`),
	CONSTRAINT `password_reset_tokens_tokenHash_unique` UNIQUE(`token_hash`)
);
--> statement-breakpoint
CREATE TABLE `permissions` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`code` varchar(80) NOT NULL,
	`module` varchar(40) NOT NULL,
	`description` varchar(255) NOT NULL,
	CONSTRAINT `permissions_id` PRIMARY KEY(`id`),
	CONSTRAINT `permissions_code_unique` UNIQUE(`code`)
);
--> statement-breakpoint
CREATE TABLE `physical_dips` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`ref` varchar(30) NOT NULL,
	`station_id` int unsigned NOT NULL,
	`tank_id` int unsigned NOT NULL,
	`product_id` int unsigned NOT NULL,
	`business_date` date NOT NULL,
	`system_stock` decimal(14,2) NOT NULL,
	`dip_litres` decimal(14,2) NOT NULL,
	`variance` decimal(14,2) NOT NULL,
	`tolerance` decimal(14,2) NOT NULL,
	`tolerance_status` enum('within_tolerance','exceeded') NOT NULL,
	`note` varchar(255),
	`recorded_by` int unsigned NOT NULL,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `physical_dips_id` PRIMARY KEY(`id`),
	CONSTRAINT `physical_dips_ref_unique` UNIQUE(`ref`),
	CONSTRAINT `physical_dips_tank_date_uq` UNIQUE(`tank_id`,`business_date`)
);
--> statement-breakpoint
CREATE TABLE `product_prices` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`product_id` int unsigned NOT NULL,
	`station_id` int unsigned,
	`price` decimal(12,2) NOT NULL,
	`effective_from` date NOT NULL,
	`created_by` int unsigned,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `product_prices_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `products` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`code` varchar(10) NOT NULL,
	`name` varchar(60) NOT NULL,
	`status` enum('active','inactive') NOT NULL DEFAULT 'active',
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `products_id` PRIMARY KEY(`id`),
	CONSTRAINT `products_code_unique` UNIQUE(`code`)
);
--> statement-breakpoint
CREATE TABLE `pumps` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`station_id` int unsigned NOT NULL,
	`tank_id` int unsigned NOT NULL,
	`name` varchar(60) NOT NULL,
	`meter_label` varchar(40),
	`initial_reading` decimal(14,2) NOT NULL DEFAULT 0,
	`status` enum('active','inactive') NOT NULL DEFAULT 'active',
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `pumps_id` PRIMARY KEY(`id`),
	CONSTRAINT `pumps_station_name_uq` UNIQUE(`station_id`,`name`)
);
--> statement-breakpoint
CREATE TABLE `ref_sequences` (
	`name` varchar(40) NOT NULL,
	`value` bigint unsigned NOT NULL DEFAULT 0,
	CONSTRAINT `ref_sequences_name` PRIMARY KEY(`name`)
);
--> statement-breakpoint
CREATE TABLE `role_permissions` (
	`role_id` int unsigned NOT NULL,
	`permission_id` int unsigned NOT NULL,
	CONSTRAINT `role_permissions_role_id_permission_id_pk` PRIMARY KEY(`role_id`,`permission_id`)
);
--> statement-breakpoint
CREATE TABLE `roles` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`name` varchar(80) NOT NULL,
	`description` varchar(255),
	`is_system` boolean NOT NULL DEFAULT false,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `roles_id` PRIMARY KEY(`id`),
	CONSTRAINT `roles_name_unique` UNIQUE(`name`)
);
--> statement-breakpoint
CREATE TABLE `rtt_entries` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`ref` varchar(20) NOT NULL,
	`station_id` int unsigned NOT NULL,
	`pump_id` int unsigned NOT NULL,
	`tank_id` int unsigned NOT NULL,
	`product_id` int unsigned NOT NULL,
	`business_date` date NOT NULL,
	`quantity` decimal(14,2) NOT NULL,
	`reason` varchar(255) NOT NULL,
	`operator_id` int unsigned NOT NULL,
	`status` enum('active','cancelled') NOT NULL DEFAULT 'active',
	`cancelled_by` int unsigned,
	`cancelled_at` datetime,
	`cancel_reason` varchar(255),
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `rtt_entries_id` PRIMARY KEY(`id`),
	CONSTRAINT `rtt_entries_ref_unique` UNIQUE(`ref`)
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` varchar(64) NOT NULL,
	`user_id` int unsigned NOT NULL,
	`ip_address` varchar(64),
	`user_agent` varchar(255),
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`last_seen_at` datetime NOT NULL,
	`expires_at` datetime NOT NULL,
	`revoked_at` datetime,
	CONSTRAINT `sessions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` varchar(80) NOT NULL,
	`value` text NOT NULL,
	`updated_by` int unsigned,
	`updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `settings_key` PRIMARY KEY(`key`)
);
--> statement-breakpoint
CREATE TABLE `stations` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`code` varchar(10) NOT NULL,
	`name` varchar(120) NOT NULL,
	`address` varchar(255),
	`manager_user_id` int unsigned,
	`cash_tolerance` decimal(16,2) NOT NULL DEFAULT 0,
	`stock_tolerance` decimal(14,2) NOT NULL DEFAULT 0,
	`status` enum('active','inactive') NOT NULL DEFAULT 'active',
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `stations_id` PRIMARY KEY(`id`),
	CONSTRAINT `stations_code_unique` UNIQUE(`code`),
	CONSTRAINT `stations_name_unique` UNIQUE(`name`)
);
--> statement-breakpoint
CREATE TABLE `stock_adjustments` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`ref` varchar(20) NOT NULL,
	`station_id` int unsigned NOT NULL,
	`tank_id` int unsigned NOT NULL,
	`product_id` int unsigned NOT NULL,
	`business_date` date NOT NULL,
	`quantity` decimal(14,2) NOT NULL,
	`reason` varchar(255) NOT NULL,
	`created_by` int unsigned NOT NULL,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `stock_adjustments_id` PRIMARY KEY(`id`),
	CONSTRAINT `stock_adjustments_ref_unique` UNIQUE(`ref`)
);
--> statement-breakpoint
CREATE TABLE `stock_ledger` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`station_id` int unsigned NOT NULL,
	`tank_id` int unsigned NOT NULL,
	`product_id` int unsigned NOT NULL,
	`business_date` date NOT NULL,
	`movement_type` enum('opening_balance','receipt','dispensed','rtt','adjustment') NOT NULL,
	`quantity` decimal(14,2) NOT NULL,
	`source_type` enum('tank','truck_receipt','dsr_reading','rtt_entry','stock_adjustment') NOT NULL,
	`source_id` int unsigned NOT NULL,
	`source_ref` varchar(60) NOT NULL,
	`voided_at` datetime,
	`voided_by` int unsigned,
	`void_reason` varchar(255),
	`created_by` int unsigned,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `stock_ledger_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `tanks` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`station_id` int unsigned NOT NULL,
	`product_id` int unsigned NOT NULL,
	`name` varchar(60) NOT NULL,
	`capacity` decimal(14,2),
	`status` enum('active','inactive') NOT NULL DEFAULT 'active',
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `tanks_id` PRIMARY KEY(`id`),
	CONSTRAINT `tanks_station_name_uq` UNIQUE(`station_id`,`name`)
);
--> statement-breakpoint
CREATE TABLE `truck_receipts` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`waybill_ref` varchar(60) NOT NULL,
	`station_id` int unsigned NOT NULL,
	`product_id` int unsigned NOT NULL,
	`tank_id` int unsigned NOT NULL,
	`truck_id` int unsigned NOT NULL,
	`git_delivery_id` int unsigned,
	`quantity` decimal(14,2) NOT NULL,
	`order_price` decimal(12,2) NOT NULL,
	`landing_price` decimal(12,2) NOT NULL,
	`business_date` date NOT NULL,
	`received_at` datetime NOT NULL,
	`status` enum('received','verified','disputed','cancelled') NOT NULL DEFAULT 'received',
	`verified_by` int unsigned,
	`verified_at` datetime,
	`dispute_reason` varchar(255),
	`disputed_by` int unsigned,
	`disputed_at` datetime,
	`cancel_reason` varchar(255),
	`cancelled_by` int unsigned,
	`cancelled_at` datetime,
	`recorded_by` int unsigned NOT NULL,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `truck_receipts_id` PRIMARY KEY(`id`),
	CONSTRAINT `truck_receipts_waybillRef_unique` UNIQUE(`waybill_ref`)
);
--> statement-breakpoint
CREATE TABLE `trucks` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`plate_number` varchar(20) NOT NULL,
	`transporter` varchar(120),
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `trucks_id` PRIMARY KEY(`id`),
	CONSTRAINT `trucks_plateNumber_unique` UNIQUE(`plate_number`)
);
--> statement-breakpoint
CREATE TABLE `user_roles` (
	`user_id` int unsigned NOT NULL,
	`role_id` int unsigned NOT NULL,
	CONSTRAINT `user_roles_user_id_role_id_pk` PRIMARY KEY(`user_id`,`role_id`)
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`username` varchar(60) NOT NULL,
	`full_name` varchar(120) NOT NULL,
	`email` varchar(190),
	`phone` varchar(30),
	`password_hash` varchar(255) NOT NULL,
	`station_id` int unsigned,
	`status` enum('active','suspended') NOT NULL DEFAULT 'active',
	`must_change_password` boolean NOT NULL DEFAULT false,
	`failed_login_count` int unsigned NOT NULL DEFAULT 0,
	`locked_until` datetime,
	`last_login_at` datetime,
	`password_changed_at` datetime,
	`created_by` int unsigned,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`deleted_at` datetime,
	CONSTRAINT `users_id` PRIMARY KEY(`id`),
	CONSTRAINT `users_username_unique` UNIQUE(`username`),
	CONSTRAINT `users_email_unique` UNIQUE(`email`)
);
--> statement-breakpoint
ALTER TABLE `audit_logs` ADD CONSTRAINT `audit_logs_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `bank_deposits` ADD CONSTRAINT `bank_deposits_station_id_stations_id_fk` FOREIGN KEY (`station_id`) REFERENCES `stations`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `bank_deposits` ADD CONSTRAINT `bank_deposits_bank_id_banks_id_fk` FOREIGN KEY (`bank_id`) REFERENCES `banks`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `bank_deposits` ADD CONSTRAINT `bank_deposits_recorded_by_users_id_fk` FOREIGN KEY (`recorded_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `bank_deposits` ADD CONSTRAINT `bank_deposits_cancelled_by_users_id_fk` FOREIGN KEY (`cancelled_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `cash_positions` ADD CONSTRAINT `cash_positions_station_id_stations_id_fk` FOREIGN KEY (`station_id`) REFERENCES `stations`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `cash_positions` ADD CONSTRAINT `cash_positions_recorded_by_users_id_fk` FOREIGN KEY (`recorded_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `cash_positions` ADD CONSTRAINT `cash_positions_reviewed_by_users_id_fk` FOREIGN KEY (`reviewed_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `cash_positions` ADD CONSTRAINT `cash_positions_closed_by_users_id_fk` FOREIGN KEY (`closed_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `debtor_transactions` ADD CONSTRAINT `debtor_transactions_debtor_id_debtors_id_fk` FOREIGN KEY (`debtor_id`) REFERENCES `debtors`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `debtor_transactions` ADD CONSTRAINT `debtor_transactions_station_id_stations_id_fk` FOREIGN KEY (`station_id`) REFERENCES `stations`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `debtor_transactions` ADD CONSTRAINT `debtor_transactions_recorded_by_users_id_fk` FOREIGN KEY (`recorded_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `debtor_transactions` ADD CONSTRAINT `debtor_transactions_voided_by_users_id_fk` FOREIGN KEY (`voided_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `debtors` ADD CONSTRAINT `debtors_station_id_stations_id_fk` FOREIGN KEY (`station_id`) REFERENCES `stations`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `debtors` ADD CONSTRAINT `debtors_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `dsr_days` ADD CONSTRAINT `dsr_days_station_id_stations_id_fk` FOREIGN KEY (`station_id`) REFERENCES `stations`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `dsr_days` ADD CONSTRAINT `dsr_days_opened_by_users_id_fk` FOREIGN KEY (`opened_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `dsr_days` ADD CONSTRAINT `dsr_days_closed_by_users_id_fk` FOREIGN KEY (`closed_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `dsr_days` ADD CONSTRAINT `dsr_days_last_reopened_by_users_id_fk` FOREIGN KEY (`last_reopened_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `dsr_readings` ADD CONSTRAINT `dsr_readings_dsr_day_id_dsr_days_id_fk` FOREIGN KEY (`dsr_day_id`) REFERENCES `dsr_days`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `dsr_readings` ADD CONSTRAINT `dsr_readings_pump_id_pumps_id_fk` FOREIGN KEY (`pump_id`) REFERENCES `pumps`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `dsr_readings` ADD CONSTRAINT `dsr_readings_tank_id_tanks_id_fk` FOREIGN KEY (`tank_id`) REFERENCES `tanks`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `dsr_readings` ADD CONSTRAINT `dsr_readings_product_id_products_id_fk` FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `exceptions` ADD CONSTRAINT `exceptions_station_id_stations_id_fk` FOREIGN KEY (`station_id`) REFERENCES `stations`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `exceptions` ADD CONSTRAINT `exceptions_reviewed_by_users_id_fk` FOREIGN KEY (`reviewed_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `exceptions` ADD CONSTRAINT `exceptions_closed_by_users_id_fk` FOREIGN KEY (`closed_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `expenses` ADD CONSTRAINT `expenses_station_id_stations_id_fk` FOREIGN KEY (`station_id`) REFERENCES `stations`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `expenses` ADD CONSTRAINT `expenses_narration_id_expense_narrations_id_fk` FOREIGN KEY (`narration_id`) REFERENCES `expense_narrations`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `expenses` ADD CONSTRAINT `expenses_decided_by_users_id_fk` FOREIGN KEY (`decided_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `expenses` ADD CONSTRAINT `expenses_recorded_by_users_id_fk` FOREIGN KEY (`recorded_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `git_deliveries` ADD CONSTRAINT `git_deliveries_git_order_id_git_orders_id_fk` FOREIGN KEY (`git_order_id`) REFERENCES `git_orders`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `git_deliveries` ADD CONSTRAINT `git_deliveries_station_id_stations_id_fk` FOREIGN KEY (`station_id`) REFERENCES `stations`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `git_events` ADD CONSTRAINT `git_events_git_order_id_git_orders_id_fk` FOREIGN KEY (`git_order_id`) REFERENCES `git_orders`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `git_events` ADD CONSTRAINT `git_events_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `git_orders` ADD CONSTRAINT `git_orders_product_id_products_id_fk` FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `git_orders` ADD CONSTRAINT `git_orders_truck_id_trucks_id_fk` FOREIGN KEY (`truck_id`) REFERENCES `trucks`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `git_orders` ADD CONSTRAINT `git_orders_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `password_reset_tokens` ADD CONSTRAINT `password_reset_tokens_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `password_reset_tokens` ADD CONSTRAINT `password_reset_tokens_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `physical_dips` ADD CONSTRAINT `physical_dips_station_id_stations_id_fk` FOREIGN KEY (`station_id`) REFERENCES `stations`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `physical_dips` ADD CONSTRAINT `physical_dips_tank_id_tanks_id_fk` FOREIGN KEY (`tank_id`) REFERENCES `tanks`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `physical_dips` ADD CONSTRAINT `physical_dips_product_id_products_id_fk` FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `physical_dips` ADD CONSTRAINT `physical_dips_recorded_by_users_id_fk` FOREIGN KEY (`recorded_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `product_prices` ADD CONSTRAINT `product_prices_product_id_products_id_fk` FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `product_prices` ADD CONSTRAINT `product_prices_station_id_stations_id_fk` FOREIGN KEY (`station_id`) REFERENCES `stations`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `product_prices` ADD CONSTRAINT `product_prices_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `pumps` ADD CONSTRAINT `pumps_station_id_stations_id_fk` FOREIGN KEY (`station_id`) REFERENCES `stations`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `pumps` ADD CONSTRAINT `pumps_tank_id_tanks_id_fk` FOREIGN KEY (`tank_id`) REFERENCES `tanks`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `role_permissions` ADD CONSTRAINT `role_permissions_role_id_roles_id_fk` FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `role_permissions` ADD CONSTRAINT `role_permissions_permission_id_permissions_id_fk` FOREIGN KEY (`permission_id`) REFERENCES `permissions`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `rtt_entries` ADD CONSTRAINT `rtt_entries_station_id_stations_id_fk` FOREIGN KEY (`station_id`) REFERENCES `stations`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `rtt_entries` ADD CONSTRAINT `rtt_entries_pump_id_pumps_id_fk` FOREIGN KEY (`pump_id`) REFERENCES `pumps`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `rtt_entries` ADD CONSTRAINT `rtt_entries_tank_id_tanks_id_fk` FOREIGN KEY (`tank_id`) REFERENCES `tanks`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `rtt_entries` ADD CONSTRAINT `rtt_entries_product_id_products_id_fk` FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `rtt_entries` ADD CONSTRAINT `rtt_entries_operator_id_users_id_fk` FOREIGN KEY (`operator_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `rtt_entries` ADD CONSTRAINT `rtt_entries_cancelled_by_users_id_fk` FOREIGN KEY (`cancelled_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sessions` ADD CONSTRAINT `sessions_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `settings` ADD CONSTRAINT `settings_updated_by_users_id_fk` FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `stations` ADD CONSTRAINT `stations_manager_user_id_users_id_fk` FOREIGN KEY (`manager_user_id`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `stock_adjustments` ADD CONSTRAINT `stock_adjustments_station_id_stations_id_fk` FOREIGN KEY (`station_id`) REFERENCES `stations`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `stock_adjustments` ADD CONSTRAINT `stock_adjustments_tank_id_tanks_id_fk` FOREIGN KEY (`tank_id`) REFERENCES `tanks`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `stock_adjustments` ADD CONSTRAINT `stock_adjustments_product_id_products_id_fk` FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `stock_adjustments` ADD CONSTRAINT `stock_adjustments_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `stock_ledger` ADD CONSTRAINT `stock_ledger_station_id_stations_id_fk` FOREIGN KEY (`station_id`) REFERENCES `stations`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `stock_ledger` ADD CONSTRAINT `stock_ledger_tank_id_tanks_id_fk` FOREIGN KEY (`tank_id`) REFERENCES `tanks`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `stock_ledger` ADD CONSTRAINT `stock_ledger_product_id_products_id_fk` FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `stock_ledger` ADD CONSTRAINT `stock_ledger_voided_by_users_id_fk` FOREIGN KEY (`voided_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `stock_ledger` ADD CONSTRAINT `stock_ledger_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `tanks` ADD CONSTRAINT `tanks_station_id_stations_id_fk` FOREIGN KEY (`station_id`) REFERENCES `stations`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `tanks` ADD CONSTRAINT `tanks_product_id_products_id_fk` FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `truck_receipts` ADD CONSTRAINT `truck_receipts_station_id_stations_id_fk` FOREIGN KEY (`station_id`) REFERENCES `stations`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `truck_receipts` ADD CONSTRAINT `truck_receipts_product_id_products_id_fk` FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `truck_receipts` ADD CONSTRAINT `truck_receipts_tank_id_tanks_id_fk` FOREIGN KEY (`tank_id`) REFERENCES `tanks`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `truck_receipts` ADD CONSTRAINT `truck_receipts_truck_id_trucks_id_fk` FOREIGN KEY (`truck_id`) REFERENCES `trucks`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `truck_receipts` ADD CONSTRAINT `truck_receipts_git_delivery_id_git_deliveries_id_fk` FOREIGN KEY (`git_delivery_id`) REFERENCES `git_deliveries`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `truck_receipts` ADD CONSTRAINT `truck_receipts_verified_by_users_id_fk` FOREIGN KEY (`verified_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `truck_receipts` ADD CONSTRAINT `truck_receipts_disputed_by_users_id_fk` FOREIGN KEY (`disputed_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `truck_receipts` ADD CONSTRAINT `truck_receipts_cancelled_by_users_id_fk` FOREIGN KEY (`cancelled_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `truck_receipts` ADD CONSTRAINT `truck_receipts_recorded_by_users_id_fk` FOREIGN KEY (`recorded_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_roles` ADD CONSTRAINT `user_roles_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_roles` ADD CONSTRAINT `user_roles_role_id_roles_id_fk` FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `users` ADD CONSTRAINT `users_station_id_stations_id_fk` FOREIGN KEY (`station_id`) REFERENCES `stations`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `audit_created_idx` ON `audit_logs` (`created_at`);--> statement-breakpoint
CREATE INDEX `audit_user_idx` ON `audit_logs` (`user_id`);--> statement-breakpoint
CREATE INDEX `audit_action_idx` ON `audit_logs` (`action`);--> statement-breakpoint
CREATE INDEX `audit_ref_idx` ON `audit_logs` (`record_ref`);--> statement-breakpoint
CREATE INDEX `audit_resource_idx` ON `audit_logs` (`resource`,`resource_id`);--> statement-breakpoint
CREATE INDEX `bank_deposits_station_date_idx` ON `bank_deposits` (`station_id`,`business_date`);--> statement-breakpoint
CREATE INDEX `debtor_tx_debtor_date_idx` ON `debtor_transactions` (`debtor_id`,`business_date`);--> statement-breakpoint
CREATE INDEX `debtor_tx_station_date_idx` ON `debtor_transactions` (`station_id`,`business_date`);--> statement-breakpoint
CREATE INDEX `dsr_days_status_idx` ON `dsr_days` (`status`);--> statement-breakpoint
CREATE INDEX `dsr_readings_pump_idx` ON `dsr_readings` (`pump_id`);--> statement-breakpoint
CREATE INDEX `exceptions_status_station_idx` ON `exceptions` (`status`,`station_id`);--> statement-breakpoint
CREATE INDEX `expenses_station_date_idx` ON `expenses` (`station_id`,`business_date`);--> statement-breakpoint
CREATE INDEX `expenses_status_idx` ON `expenses` (`status`);--> statement-breakpoint
CREATE INDEX `expenses_narration_idx` ON `expenses` (`narration_id`);--> statement-breakpoint
CREATE INDEX `git_deliveries_station_idx` ON `git_deliveries` (`station_id`);--> statement-breakpoint
CREATE INDEX `git_events_order_idx` ON `git_events` (`git_order_id`);--> statement-breakpoint
CREATE INDEX `git_orders_status_idx` ON `git_orders` (`status`);--> statement-breakpoint
CREATE INDEX `git_orders_date_idx` ON `git_orders` (`order_date`);--> statement-breakpoint
CREATE INDEX `password_reset_user_idx` ON `password_reset_tokens` (`user_id`);--> statement-breakpoint
CREATE INDEX `physical_dips_station_date_idx` ON `physical_dips` (`station_id`,`business_date`);--> statement-breakpoint
CREATE INDEX `product_prices_lookup_idx` ON `product_prices` (`product_id`,`station_id`,`effective_from`);--> statement-breakpoint
CREATE INDEX `pumps_tank_idx` ON `pumps` (`tank_id`);--> statement-breakpoint
CREATE INDEX `rtt_station_date_idx` ON `rtt_entries` (`station_id`,`business_date`);--> statement-breakpoint
CREATE INDEX `rtt_pump_date_idx` ON `rtt_entries` (`pump_id`,`business_date`);--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `sessions_expires_idx` ON `sessions` (`expires_at`);--> statement-breakpoint
CREATE INDEX `stock_adjustments_tank_date_idx` ON `stock_adjustments` (`tank_id`,`business_date`);--> statement-breakpoint
CREATE INDEX `stock_ledger_tank_date_idx` ON `stock_ledger` (`tank_id`,`business_date`);--> statement-breakpoint
CREATE INDEX `stock_ledger_station_product_date_idx` ON `stock_ledger` (`station_id`,`product_id`,`business_date`);--> statement-breakpoint
CREATE INDEX `stock_ledger_source_idx` ON `stock_ledger` (`source_type`,`source_id`);--> statement-breakpoint
CREATE INDEX `tanks_station_product_idx` ON `tanks` (`station_id`,`product_id`);--> statement-breakpoint
CREATE INDEX `truck_receipts_station_date_idx` ON `truck_receipts` (`station_id`,`business_date`);--> statement-breakpoint
CREATE INDEX `truck_receipts_status_idx` ON `truck_receipts` (`status`);--> statement-breakpoint
CREATE INDEX `truck_receipts_delivery_idx` ON `truck_receipts` (`git_delivery_id`);--> statement-breakpoint
CREATE INDEX `user_roles_role_idx` ON `user_roles` (`role_id`);--> statement-breakpoint
CREATE INDEX `users_station_idx` ON `users` (`station_id`);--> statement-breakpoint
CREATE INDEX `users_status_idx` ON `users` (`status`);