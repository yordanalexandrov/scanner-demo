import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor } from './cursor.js';

describe('cursors', () => {
  it('round-trips', () => {
    const cursor = { createdAt: 1_770_000_000_000, id: 'a-b-c' };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it('keeps an ID that contains the separator intact', () => {
    // The split is on the first colon only, so an ID may contain one without corrupting the cursor.
    const cursor = { createdAt: 1, id: 'a:b:c' };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it.each([
    ['not base64 at all', '!!!!'],
    ['base64 without a separator', Buffer.from('nope', 'utf8').toString('base64url')],
    ['a non-numeric timestamp', Buffer.from('abc:id', 'utf8').toString('base64url')],
    ['an empty ID', Buffer.from('1:', 'utf8').toString('base64url')],
  ])('returns null for %s', (_label, value) => {
    expect(decodeCursor(value)).toBeNull();
  });
});
