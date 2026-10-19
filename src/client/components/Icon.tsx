import type { SVGProps } from 'react';

// A small, consistent 24px stroke icon set (1.6px strokes, round joins).
const PATHS = {
  play: <path d="M7 4.5v15l12.5-7.5z" fill="currentColor" stroke="none" />,
  pause: (
    <>
      <rect x="6" y="4.5" width="4" height="15" rx="1" fill="currentColor" stroke="none" />
      <rect x="14" y="4.5" width="4" height="15" rx="1" fill="currentColor" stroke="none" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5.5M12 7.6v.1" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  heart: (
    <path d="M12 20s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.2a4.3 4.3 0 0 1 7.5 2.6C19.5 15.4 12 20 12 20z" />
  ),
  bookmark: <path d="M7 4h10v16l-5-3.5L7 20z" />,
  bookmarkFilled: <path d="M7 4h10v16l-5-3.5L7 20z" fill="currentColor" />,
  heartFilled: (
    <path
      d="M12 20s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.2a4.3 4.3 0 0 1 7.5 2.6C19.5 15.4 12 20 12 20z"
      fill="currentColor"
    />
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4 4" />
    </>
  ),
  settings: (
    <>
      <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
      <circle cx="16" cy="7" r="2" />
      <circle cx="10" cy="17" r="2" />
    </>
  ),
  home: <path d="M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1h-4.5v-6h-5v6H5a1 1 0 0 1-1-1z" />,
  grid: (
    <>
      <rect x="4" y="4" width="6.5" height="6.5" rx="1" />
      <rect x="13.5" y="4" width="6.5" height="6.5" rx="1" />
      <rect x="4" y="13.5" width="6.5" height="6.5" rx="1" />
      <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1" />
    </>
  ),
  stack: (
    <>
      <rect x="4" y="8" width="16" height="12" rx="1.5" />
      <path d="M6.5 5h11M9 2.5h6" />
    </>
  ),
  chevronLeft: <path d="m14.5 5.5-6.5 6.5 6.5 6.5" />,
  chevronRight: <path d="m9.5 5.5 6.5 6.5-6.5 6.5" />,
  chevronDown: <path d="m5.5 9.5 6.5 6.5 6.5-6.5" />,
  arrowUp: <path d="M12 19V5M6 11l6-6 6 6" />,
  arrowDown: <path d="M12 5v14M6 13l6 6 6-6" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  shuffle: (
    <path d="M4 7h3.5c4.5 0 4.5 10 9 10H20M17 14l3 3-3 3M4 17h3.5c1.5 0 2.4-1.1 3.1-2.6M13.4 9.6C14.1 8.1 15 7 16.5 7H20M17 4l3 3-3 3" />
  ),
  star: <path d="m12 4 2.5 5.2 5.7.8-4.1 4 1 5.6L12 17l-5.1 2.6 1-5.6-4.1-4 5.7-.8z" />,
  starFilled: (
    <path
      d="m12 4 2.5 5.2 5.7.8-4.1 4 1 5.6L12 17l-5.1 2.6 1-5.6-4.1-4 5.7-.8z"
      fill="currentColor"
    />
  ),
  volume: (
    <>
      <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" />
      <path d="M15.5 9a4.2 4.2 0 0 1 0 6M18 6.5a7.8 7.8 0 0 1 0 11" />
    </>
  ),
  mute: (
    <>
      <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" />
      <path d="m16 9.5 5 5M21 9.5l-5 5" />
    </>
  ),
  fullscreen: <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />,
  exitFullscreen: <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />,
  captions: (
    <>
      <rect x="3" y="5.5" width="18" height="13" rx="2" />
      <path d="M10.5 10.3a2.3 2.3 0 1 0 0 3.4M17.5 10.3a2.3 2.3 0 1 0 0 3.4" />
    </>
  ),
  rewind: (
    <>
      <path d="M5 12a7 7 0 1 0 2.1-5" />
      <path d="M4.5 4v4h4" />
      <text
        x="12"
        y="15"
        fontSize="6.5"
        textAnchor="middle"
        fill="currentColor"
        stroke="none"
        fontWeight="700"
      >
        10
      </text>
    </>
  ),
  forward: (
    <>
      <path d="M19 12a7 7 0 1 1-2.1-5" />
      <path d="M19.5 4v4h-4" />
      <text
        x="12"
        y="15"
        fontSize="6.5"
        textAnchor="middle"
        fill="currentColor"
        stroke="none"
        fontWeight="700"
      >
        30
      </text>
    </>
  ),
  trash: <path d="M5 7h14M10 7V4.5h4V7M7 7l1 12.5h8L17 7M10.5 11v5M13.5 11v5" />,
  edit: <path d="M4.5 19.5 5 16 15.5 5.5a2.1 2.1 0 0 1 3 3L8 19zM13.5 7.5l3 3" />,
  sliders: (
    <>
      <path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1" />
      <circle cx="15" cy="6" r="2" />
      <circle cx="9" cy="12" r="2" />
      <circle cx="17" cy="18" r="2" />
    </>
  ),
  sortAsc: <path d="M7 5v14M4 8l3-3 3 3M13 7h7M13 12h5M13 17h3" />,
  sortDesc: <path d="M7 5v14M4 16l3 3 3-3M13 7h3M13 12h5M13 17h7" />,
  refresh: (
    <>
      <path d="M19.5 12a7.5 7.5 0 0 1-13.3 4.8M4.5 12a7.5 7.5 0 0 1 13.3-4.8" />
      <path d="M18 3.5v4h-4M6 20.5v-4h4" />
    </>
  ),
  eye: (
    <>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="2.8" />
    </>
  ),
  eyeOff: (
    <path d="M3 3l18 18M10.6 6a9.6 9.6 0 0 1 1.4-.1c6 0 9.5 6.1 9.5 6.1a17 17 0 0 1-2.6 3.3M6.4 7.4C3.9 9.1 2.5 12 2.5 12S6 18.5 12 18.5c1.6 0 3-.4 4.2-1.1M9.9 9.9a2.8 2.8 0 0 0 4 4" />
  ),
  upload: <path d="M12 16V4M7 9l5-5 5 5M4.5 15v4.5h15V15" />,
  image: (
    <>
      <rect x="3.5" y="5" width="17" height="14" rx="1.5" />
      <circle cx="9" cy="10" r="1.6" />
      <path d="m4 18 5.5-5 4 3.5 2.5-2 4.5 3.5" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8.5" r="3.8" />
      <path d="M4.5 20c.8-3.8 3.8-5.8 7.5-5.8s6.7 2 7.5 5.8" />
    </>
  ),
  logout: (
    <path d="M14 4.5H6.5a1 1 0 0 0-1 1v13a1 1 0 0 0 1 1H14M10.5 12H20M16.5 8.5 20 12l-3.5 3.5" />
  ),
  offline: (
    <>
      <path d="M3 3l18 18M8.5 16.5a5 5 0 0 1 7 0M5 13a10 10 0 0 1 4.3-2.4M19 13a10 10 0 0 0-2.6-1.9M2 9.5a15 15 0 0 1 4.5-2.7M22 9.5A15 15 0 0 0 10.5 5.6" />
      <circle cx="12" cy="20" r=".6" fill="currentColor" />
    </>
  ),
  alert: (
    <>
      <path d="M12 3.5 2.5 20h19z" />
      <path d="M12 10v4.5M12 17.2v.1" />
    </>
  ),
  wheel: (
    <>
      <circle cx="12" cy="13" r="8" />
      <path d="M12 5v16M4 13h16M6.3 7.3l11.4 11.4M17.7 7.3 6.3 18.7" />
      <path d="M10 2.5h4l-2 3z" fill="currentColor" />
    </>
  ),
  disc: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="2.5" />
      <path d="M12 6a6 6 0 0 0-6 6" />
    </>
  ),
  film: (
    <>
      <rect x="3.5" y="3.5" width="17" height="17" rx="1.5" />
      <path d="M7.5 3.5v17M16.5 3.5v17M3.5 8h4M3.5 12h4M3.5 16h4M16.5 8h4M16.5 12h4M16.5 16h4" />
    </>
  ),
  tv: (
    <>
      <rect x="3" y="6.5" width="18" height="12.5" rx="1.5" />
      <path d="M8.5 3l3.5 3.5L15.5 3M8 21.5h8" />
    </>
  ),
  pin: <path d="M9 4h6l-1 5 3.5 3.5v1.5h-11v-1.5L10 9zM12 14v6" />,
  drag: (
    <>
      <circle cx="9" cy="7" r="1.2" fill="currentColor" />
      <circle cx="15" cy="7" r="1.2" fill="currentColor" />
      <circle cx="9" cy="12" r="1.2" fill="currentColor" />
      <circle cx="15" cy="12" r="1.2" fill="currentColor" />
      <circle cx="9" cy="17" r="1.2" fill="currentColor" />
      <circle cx="15" cy="17" r="1.2" fill="currentColor" />
    </>
  ),
  audio: (
    <>
      <path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2" />
    </>
  ),
  share: (
    <>
      <circle cx="12" cy="8.5" r="3" />
      <circle cx="5.5" cy="17" r="2.2" />
      <circle cx="18.5" cy="17" r="2.2" />
      <path d="M9.6 10.4 7 15M14.4 10.4 17 15" />
    </>
  ),
} as const;

export type IconName = keyof typeof PATHS;

interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: IconName;
  size?: number;
}

export function Icon({ name, size = 20, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {PATHS[name]}
    </svg>
  );
}
