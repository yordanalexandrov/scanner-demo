import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { AttemptListQuery } from '@scanner-demo/shared';
import type { Db } from '../db/client.js';
import { attempts, images } from '../db/schema.js';
import type { ListCursor } from './cursor.js';

/**
 * The benchmark listing behind History and the JSON export, built in one place.
 *
 * It is a module rather than a block inside the route for the reason `imageQuery.ts` is: the query
 * plan is checked by a test, and a plan check is only evidence if it explains **the query the route
 * runs**. A second, similar query written in the test would prove nothing about this one.
 *
 * Every filter is answered in SQL. Fetching pages and narrowing them on the phone would make the
 * per-method medians on screen depend on how far the operator had scrolled - which is precisely the
 * kind of number this project exists not to produce.
 *
 * The unfiltered walk - the one the JSON export pages through to exhaustion - reads
 * `attempts_createdAt_id_idx` in order and never sorts. A `method` filter takes the
 * `(method, inputVariant)` index instead and then sorts what it matched, because no single index
 * can serve an equality on one column and an ordering on another. That is a sort over the matched
 * subset rather than a table scan, and it is the same trade the image listing documents for its
 * `capturedAt` range.
 */

/**
 * The photograph's origin, which lives on `images` and not on `attempts`.
 *
 * An `exists` against the image's primary key rather than a join: a join would change the shape of
 * every row the route reads back, and this filter is the only thing on this listing that needs the
 * other table at all. Denormalising `source` onto `attempts` was the alternative and was not taken -
 * it would be a third copy of a fact `images` already owns, kept in step by nothing.
 *
 * The row it asks about is the one the attempt names. Under ADR-20 that is the capture group's
 * uploaded row whichever variant's pixels were read, and every variant of a group shares one
 * `source`, so the answer is the same either way.
 */
function imageHasSource(source: string): SQL {
  return sql`exists (select 1 from ${images} where ${images.id} = ${attempts.imageId} and ${images.source} = ${source})`;
}

/** Everything the query filters on, cursor included. Empty for the unfiltered first page. */
export function attemptListConditions(query: AttemptListQuery, cursor: ListCursor | null): SQL[] {
  const conditions: SQL[] = [];

  if (cursor !== null) {
    // Newest first, so "after the cursor" means strictly older. `id` breaks ties, because the four
    // methods of one re-run-all land within the same millisecond routinely.
    conditions.push(
      sql`(${attempts.createdAt} < ${cursor.sortKey} or (${attempts.createdAt} = ${cursor.sortKey} and ${attempts.id} < ${cursor.id}))`,
    );
  }

  if (query.method !== undefined) {
    conditions.push(eq(attempts.method, query.method));
  }
  // Never conflated with the image listing's `variant`: this is which pixels the *run* read - ADR-2.
  if (query.inputVariant !== undefined) {
    conditions.push(eq(attempts.inputVariant, query.inputVariant));
  }
  if (query.parserVersion !== undefined) {
    conditions.push(eq(attempts.parserVersion, query.parserVersion));
  }
  if (query.timingVersion !== undefined) {
    conditions.push(eq(attempts.timingVersion, query.timingVersion));
  }
  if (query.source !== undefined) {
    conditions.push(imageHasSource(query.source));
  }

  // The range is over `createdAt` - when the run happened - which is also what the listing orders
  // and paginates on, so the filter and the cursor read the same index and neither costs a sort.
  // The image listing ranges over `capturedAt` instead, and the difference is deliberate: there a
  // date means "photos I shot today", here it means "runs from this session".
  if (query.from !== undefined) {
    conditions.push(gte(attempts.createdAt, query.from));
  }
  if (query.to !== undefined) {
    conditions.push(lte(attempts.createdAt, query.to));
  }

  return conditions;
}

/**
 * One row beyond the page is selected on purpose, purely to learn whether another page exists
 * without a `count(*)` over the whole filtered set.
 */
export function attemptListQuery(db: Db, query: AttemptListQuery, cursor: ListCursor | null) {
  const conditions = attemptListConditions(query, cursor);

  return db
    .select()
    .from(attempts)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(attempts.createdAt), desc(attempts.id))
    .limit(query.limit + 1);
}
