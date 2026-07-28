/**
 * Keyset pagination cursors for the image listing.
 *
 * Offset pagination would skip or repeat rows here, because the store is append-only and the
 * listing is newest-first: every upload during a scroll shifts every subsequent offset by one. A
 * cursor naming the last row seen is immune to that.
 *
 * The encoding is opaque to the client by intent - it is base64url, not a promise.
 */

export interface ListCursor {
  createdAt: number;
  id: string;
}

export function encodeCursor(cursor: ListCursor): string {
  return Buffer.from(`${cursor.createdAt}:${cursor.id}`, 'utf8').toString('base64url');
}

/** `null` for anything that is not a cursor this server issued. The route answers 400. */
export function decodeCursor(encoded: string): ListCursor | null {
  const decoded = Buffer.from(encoded, 'base64url').toString('utf8');
  const separator = decoded.indexOf(':');

  if (separator <= 0) {
    return null;
  }

  const createdAt = Number(decoded.slice(0, separator));
  const id = decoded.slice(separator + 1);

  if (!Number.isSafeInteger(createdAt) || id.length === 0) {
    return null;
  }

  return { createdAt, id };
}
