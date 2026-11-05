-- Create "parent_table" table
CREATE TABLE `parent_table` (
  `id` text NOT NULL,
  `name` text NULL,
  `description` text NOT NULL,
  PRIMARY KEY (`id`)
);
-- Create "child_table" table
CREATE TABLE `child_table` (
  `id` text NOT NULL,
  `parent_id` text NOT NULL,
  `name` text NULL,
  `description` text NULL,
  PRIMARY KEY (`id`),
  CONSTRAINT `fk_parent_id` FOREIGN KEY (`parent_id`) REFERENCES `parent_table` (`id`) ON UPDATE CASCADE ON DELETE CASCADE
);
