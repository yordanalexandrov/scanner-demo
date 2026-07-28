import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  extensionForMimeType,
  imageFilePath,
  InvalidImagePathError,
  isImageId,
  isSupportedMimeType,
  resolveInside,
  thumbnailFilePath,
} from './imagePaths.js';

const BASE = '/srv/scanner/images';
const ID = '1b3c9b6e-9c1c-4a2e-9e6a-4a1c9d2f5b7e';

describe('isImageId', () => {
  it('accepts a UUID the server minted', () => {
    expect(isImageId(ID)).toBe(true);
  });

  it.each([
    ['traversal', '../../etc/passwd'],
    ['encoded traversal, already decoded by the router', '..%2F..%2Fetc%2Fpasswd'],
    ['absolute path', '/etc/passwd'],
    ['a nul byte, the classic truncation trick', `${ID}\0.jpg`],
    ['a UUID with a suffix', `${ID}.jpg`],
    ['empty', ''],
  ])('rejects %s', (_label, value) => {
    expect(isImageId(value)).toBe(false);
  });
});

describe('resolveInside', () => {
  it('resolves an ordinary name under the base directory', () => {
    expect(resolveInside(BASE, 'a.jpg')).toBe(path.join(BASE, 'a.jpg'));
  });

  it.each(['../secret.jpg', '../../etc/passwd', '/etc/passwd', 'a/../../b.jpg'])(
    'refuses %s',
    (name) => {
      expect(() => resolveInside(BASE, name)).toThrow(InvalidImagePathError);
    },
  );

  it('refuses a sibling directory that merely shares a prefix', () => {
    // Without the separator in the containment test, `/srv/scanner/images-old` would pass.
    expect(() => resolveInside(BASE, '../images-old/a.jpg')).toThrow(InvalidImagePathError);
  });
});

describe('mime types', () => {
  it('maps the accepted types to extensions', () => {
    expect(extensionForMimeType('image/jpeg')).toBe('jpg');
    expect(extensionForMimeType('image/png')).toBe('png');
    expect(extensionForMimeType('image/heic')).toBe('heic');
  });

  it('rejects SVG, which sharp can decode but this dataset must never hold', () => {
    expect(isSupportedMimeType('image/svg+xml')).toBe(false);
    expect(() => extensionForMimeType('image/svg+xml')).toThrow(InvalidImagePathError);
  });

  it('rejects a type that is not an image at all', () => {
    expect(() => extensionForMimeType('application/json')).toThrow(InvalidImagePathError);
  });
});

describe('imageFilePath', () => {
  it('builds the path from the ID and the server-detected type', () => {
    expect(imageFilePath(BASE, ID, 'image/jpeg')).toBe(path.join(BASE, `${ID}.jpg`));
  });

  it('refuses an ID that is not one', () => {
    expect(() => imageFilePath(BASE, '../../etc/passwd', 'image/jpeg')).toThrow(
      InvalidImagePathError,
    );
  });
});

describe('thumbnailFilePath', () => {
  it('is always JPEG, whatever the source was', () => {
    expect(thumbnailFilePath(BASE, ID)).toBe(path.join(BASE, `${ID}.jpg`));
  });

  it('refuses an ID that is not one', () => {
    expect(() => thumbnailFilePath(BASE, '..')).toThrow(InvalidImagePathError);
  });
});
