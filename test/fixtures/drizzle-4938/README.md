The `drizzle-clean` migrations plus `0003_title_nullable.sql`, which drizzle-kit 0.31.11 generated after `posts.title` lost its `.notNull()`. SQLite cannot drop NOT NULL in place, so drizzle-kit rebuilds `posts` (create, copy, drop, rename) inside `PRAGMA foreign_keys=OFF`. On D1 that pragma does nothing, and dropping `posts` deletes every row of `comments` and `post_tags` through ON DELETE CASCADE. Related report: https://github.com/drizzle-team/drizzle-orm/issues/4938.

Expected: `sql-hotroll lint` exits 1 with CASCADE-LOSS on `comments` and `post_tags`.
