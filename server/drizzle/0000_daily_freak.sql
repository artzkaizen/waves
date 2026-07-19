CREATE TABLE `auth_sessions` (
	`token` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `exercise_data` (
	`exercise_id` text PRIMARY KEY NOT NULL,
	`payload` text NOT NULL,
	`computed_at` text NOT NULL,
	FOREIGN KEY (`exercise_id`) REFERENCES `exercises`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `exercises` (
	`id` text PRIMARY KEY NOT NULL,
	`experiment_id` text NOT NULL,
	`created_at` text NOT NULL,
	`properties` text DEFAULT '{}' NOT NULL,
	`recording_status` text DEFAULT 'idle' NOT NULL,
	`has_data` integer DEFAULT false NOT NULL,
	`recording_started_at` text,
	`recording_ended_at` text,
	`device` text,
	`audio_path` text,
	`audio_rate` integer,
	`video_path` text,
	`video_fps` integer,
	`poster_path` text,
	`notes` text,
	FOREIGN KEY (`experiment_id`) REFERENCES `experiments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_exercises_experiment` ON `exercises` (`experiment_id`);--> statement-breakpoint
CREATE TABLE `experiments` (
	`id` text PRIMARY KEY NOT NULL,
	`patient_number` text,
	`height` real,
	`age` integer,
	`weight` real,
	`created_at` text NOT NULL,
	`properties` text DEFAULT '{}' NOT NULL,
	`owner_id` text,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `readings` (
	`exercise_id` text NOT NULL,
	`seq` integer NOT NULL,
	`t` real NOT NULL,
	`ax` real,
	`ay` real,
	`az` real,
	`gx` real,
	`gy` real,
	`gz` real,
	`db` real,
	PRIMARY KEY(`exercise_id`, `seq`),
	FOREIGN KEY (`exercise_id`) REFERENCES `exercises`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_readings_exercise` ON `readings` (`exercise_id`,`seq`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`password_hash` text NOT NULL,
	`role` text DEFAULT 'experimenter' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);