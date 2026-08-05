/**
 * The popup's drawings.
 *
 * Inline SVG rather than an icon font or a sprite sheet: the manifest CSP
 * forbids remote anything, and inlining keeps every glyph themeable through
 * `currentColor` so a tile, a nav item and a disabled state can share one path.
 *
 * The hat is the mascot. Hoodini is a stage magician's name, so the reference
 * writes itself, and the reference wallet Rory pinned leads with a sleepy
 * cartoon too — a product that holds your keys is allowed one piece of charm as
 * long as nothing load-bearing depends on it.
 */

export function TopHat({ size = 128 }: { size?: number }): React.JSX.Element {
  return (
    <svg className="hat" width={size} height={size * 0.86} viewBox="0 0 148 128" fill="none" aria-hidden="true">
      {/* Brim first, so the crown sits on top of it. */}
      <ellipse cx="74" cy="102" rx="66" ry="17" fill="#e9eef7" />
      <ellipse cx="74" cy="99" rx="66" ry="17" fill="#ffffff" />
      <path d="M32 99V38c0-14 19-25 42-25s42 11 42 25v61c0 9-19 16-42 16s-42-7-42-16Z" fill="#ffffff" />
      {/* The band carries the brand colour; the hat itself stays white so it
          reads at 16px in a toolbar as well as at 128px on the lock screen. */}
      <path d="M32 74c0 9 19 16 42 16s42-7 42-16v14c0 9-19 16-42 16s-42-7-42-16V74Z" fill="#4da3ff" />
      {/* Sleepy eyes. Closed, because the wallet is resting until you unlock it. */}
      <path d="M56 52c3.5-4.5 9.5-4.5 13 0" stroke="#0a0f18" strokeWidth="4.5" strokeLinecap="round" />
      <path d="M79 52c3.5-4.5 9.5-4.5 13 0" stroke="#0a0f18" strokeWidth="4.5" strokeLinecap="round" />
      {/* A little escape act: three puffs drifting off the brim. */}
      <circle cx="128" cy="70" r="4" fill="#4da3ff" opacity="0.55" />
      <circle cx="137" cy="56" r="2.8" fill="#4da3ff" opacity="0.38" />
      <circle cx="143" cy="44" r="1.8" fill="#4da3ff" opacity="0.24" />
    </svg>
  );
}

const S = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };

export const Icon = {
  send: () => (
    <svg {...S} aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7" /></svg>
  ),
  receive: () => (
    <svg {...S} aria-hidden="true"><path d="M12 5v14M19 12l-7 7-7-7" /></svg>
  ),
  trade: () => (
    <svg {...S} aria-hidden="true"><path d="M16 3h5v5M21 3l-7 7M8 21H3v-5M3 21l7-7" /></svg>
  ),
  lock: () => (
    <svg {...S} aria-hidden="true"><rect x="4" y="10" width="16" height="11" rx="2.5" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></svg>
  ),
  home: () => (
    <svg {...S} width={20} height={20} aria-hidden="true"><path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1v-9.5Z" /></svg>
  ),
  activity: () => (
    <svg {...S} width={20} height={20} aria-hidden="true"><path d="M3 12h4l3 8 4-16 3 8h4" /></svg>
  ),
  settings: () => (
    <svg {...S} width={20} height={20} aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1v.3a2 2 0 1 1-4 0v-.2a1.6 1.6 0 0 0-2.8-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 3.5 15H3a2 2 0 1 1 0-4h.2a1.6 1.6 0 0 0 1.1-2.7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.2a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.2a1.6 1.6 0 0 0-1.4 1Z" /></svg>
  ),
  copy: () => (
    <svg {...S} width={13} height={13} aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" /></svg>
  ),
  check: () => (
    <svg {...S} width={13} height={13} aria-hidden="true"><path d="m5 13 4 4L19 7" /></svg>
  ),
  bolt: () => (
    <svg {...S} aria-hidden="true"><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" /></svg>
  ),
};
