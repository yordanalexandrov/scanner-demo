/**
 * Keyset pagination cursors, shared by every newest-first listing the API serves.
 *
 * Offset pagination would skip or repeat rows here, because the stores are append-only and the
 * listings are newest-first: every row written during a scroll shifts every subsequent offset by
 * one. A cursor naming the last row seen is immune to that.
 *
 * The encoding is opaque to the client by intent - it is base64url, not a promise.
 */

export interface ListCursor {
  /**
   * The server-assigned timestamp the listing is ordered on - `createdAt` for images, `scannedAt`
   * for barcode scans. Named for its role rather than for one table's column, because a cursor is
   * only ever compared against the field its own listing sorts by.
   */
  sortKey: number;
  id: string;
}

export function encodeCursor(cursor: ListCursor): string {
  return Buffer.from(`${cursor.sortKey}:${cursor.id}`, 'utf8').toString('base64url');
}

/** `null` for anything that is not a cursor this server issued. The route answers 400. */
export function decodeCursor(encoded: string): ListCursor | null {
  const decoded = Buffer.from(encoded, 'base64url').toString('utf8');
  const separator = decoded.indexOf(':');

  if (separator <= 0) {
    return null;
  }

  const sortKey = Number(decoded.slice(0, separator));
  const id = decoded.slice(separator + 1);

  if (!Number.isSafeInteger(sortKey) || id.length === 0) {
    return null;
  }

  return { sortKey, id };
}
