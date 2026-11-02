-- Disable the enforcement of foreign-keys constraints
PRAGMA foreign_keys = off;
-- Create "new_parent_table" table
CREATE TABLE `new_parent_table` (
  `id` text NOT NULL,
  `name` text NULL,
  `description` text NULL,
  PRIMARY KEY (`id`)
);
-- Copy rows from old table "parent_table" to new temporary table "new_parent_table"
INSERT INTO `new_parent_table` (`id`, `name`, `description`) SELECT `id`, `name`, `description` FROM `parent_table`;
-- Drop "parent_table" table after copying rows
DROP TABLE `parent_table`;
-- Rename temporary table "new_parent_table" to "parent_table"
ALTER TABLE `new_parent_table` RENAME TO `parent_table`;
-- Enable back the enforcement of foreign-keys constraints
PRAGMA foreign_keys = on;
