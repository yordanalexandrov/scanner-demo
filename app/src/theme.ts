/**
 * The handful of values the shell reuses.
 *
 * This is a benchmark harness, not a product - the palette exists so that the health indicator and
 * the placeholder screens agree with each other, not to build a design system.
 */

export const colors = {
  background: '#f4f5f7',
  surface: '#ffffff',
  border: '#dcdfe4',
  text: '#101418',
  textMuted: '#5c6672',
  accent: '#1f6feb',
  online: '#1a7f37',
  offline: '#c1121f',
  checking: '#9a6700',
  warningSurface: '#fff8e5',
  warningBorder: '#e6c66b',
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
} as const;

export const radius = { md: 10 } as const;
