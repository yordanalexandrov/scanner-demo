import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { ImageListQuery } from '@scanner-demo/shared';
import type { Db } from '../db/client.js';
import { attempts, images } from '../db/schema.js';
import type { ListCursor } from './cursor.js';

/**
 * The image listing, built in one place.
 *
 * It is a module rather than a block inside the route because acceptance criterion 10 of phase 06
 * asks for `EXPLAIN QUERY PLAN` to show no full table scan on `images`, and a plan check is only
 * evidence if it explains **the query the route runs**. The test calls this function and explains
 * what it returns; a second, similar query written in the test would prove nothing about this one.
 *
 * Every filter is answered in SQL. Fetching pages and narrowing them in the app would make the
 * counts on screen depend on how far the operator had scrolled.
 */

/**
 * Whether any attempt exists for the row's **capture group**, optionally one that extracted a date.
 *
 * The join is on `captureGroupId`, not on `imageId`, and that is the whole point of the column being
 * denormalised onto `attempts`. A Library re-run records against the group's uploaded row whichever
 * variant it read - ADR-20 - so asking `imageId` would answer "never benchmarked" for every archived
 * original, and the filter that exists to find un-run packaging would return mostly noise.
 */
function groupHasAttempt(options: { withDate: boolean }): SQL {
  const withDate = options.withDate
    ? sql` and ${attempts.expiryDate} is not null`
    : // An empty fragment rather than a second query: the two forms differ by one predicate.
      sql``;

  return sql`select 1 from ${attempts} where ${attempts.captureGroupId} = ${images.captureGroupId}${withDate}`;
}

/** Everything the query filters on, cursor included. Empty for the unfiltered first page. */
export function imageListConditions(query: ImageListQuery, cursor: ListCursor | null): SQL[] {
  const conditions: SQL[] = [];

  if (cursor !== null) {
    // Newest first, so "after the cursor" means strictly older. `id` breaks ties, because two
    // uploads can share a millisecond.
    conditions.push(
      sql`(${images.createdAt} < ${cursor.sortKey} or (${images.createdAt} = ${cursor.sortKey} and ${images.id} < ${cursor.id}))`,
    );
  }

  if (query.source !== undefined) {
    conditions.push(eq(images.source, query.source));
  }
  if (query.variant !== undefined) {
    conditions.push(eq(images.variant, query.variant));
  }
  if (query.captureGroupId !== undefined) {
    conditions.push(eq(images.captureGroupId, query.captureGroupId));
  }
  // The date range filters on when the photo was taken, not when it was stored.
  //
  // It is the one filter that still costs a sort: SQLite reads it out of `images_capturedAt_idx`
  // and then builds a temp b-tree for the `createdAt` ordering, because no single index can serve a
  // range on one column and an ordering on another. That is a sort, not the table scan criterion 10
  // forbids, and it is over a few hundred rows here. Ordering the listing by `capturedAt` would
  // remove it and break the cursor - `capturedAt` comes from a gallery import's EXIF and can be
  // backdated, so it cannot carry a stable keyset.
  if (query.from !== undefined) {
    conditions.push(gte(images.capturedAt, query.from));
  }
  if (query.to !== undefined) {
    conditions.push(lte(images.capturedAt, query.to));
  }

  if (query.hasAttempts !== undefined) {
    const subquery = groupHasAttempt({ withDate: false });
    conditions.push(query.hasAttempts ? sql`exists (${subquery})` : sql`not exists (${subquery})`);
  }

  if (query.hasDate !== undefined) {
    const subquery = groupHasAttempt({ withDate: true });
    // `hasDate=false` therefore also holds for an image nothing has been run against yet, which is
    // what "no date has been extracted from this" means to someone looking for work still to do.
    conditions.push(query.hasDate ? sql`exists (${subquery})` : sql`not exists (${subquery})`);
  }

  return conditions;
}

/**
 * One row beyond the page is selected on purpose, purely to learn whether another page exists
 * without a `count(*)` over the whole filtered set.
 */
export function imageListQuery(db: Db, query: ImageListQuery, cursor: ListCursor | null) {
  const conditions = imageListConditions(query, cursor);

  return db
    .select()
    .from(images)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(images.createdAt), desc(images.id))
    .limit(query.limit + 1);
}
