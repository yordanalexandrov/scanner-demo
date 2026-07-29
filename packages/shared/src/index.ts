/**
 * `@scanner-demo/shared` - the contracts the benchmark is built on.
 *
 * Everything here exists exactly once and is imported by both the app and the server. That is what
 * makes the comparison between the four extraction methods valid: an accuracy difference has to
 * come from the OCR, because nothing downstream of it differs.
 *
 * The date parser joins this package in phase 05.
 */

export * from './schemas/ocr.js';
export * from './schemas/image.js';
export * from './schemas/api.js';
export * from './schemas/attempt.js';
export * from './schemas/barcode.js';
export * from './schemas/parse.js';

export * from './data/anchors.js';
export * from './data/months.js';

export * from './timing.js';
export * from './stats.js';
export * from './pricing.js';
