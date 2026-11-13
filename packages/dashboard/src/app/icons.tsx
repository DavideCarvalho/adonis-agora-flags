import type { ReactNode, SVGProps } from 'react';

/**
 * The flags console's own glyphs: its brand mark and its nav icons (16px stroke, currentColor, the
 * kit's icon style). Shared chrome icons live in `agora-kit/icons.tsx`.
 */
function icon(paths: ReactNode) {
  // biome-ignore lint/correctness/noComponentHookFactories: a static icon table built once at module load, no hooks inside
  return function Icon(props: SVGProps<SVGSVGElement>) {
    return (
      <svg
        viewBox="0 0 16 16"
        width={16}
        height={16}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
        {...props}
      >
        {paths}
      </svg>
    );
  };
}

/** The brand mark: a flag on its pole. */
export const LogoMark = icon(
  <>
    <path d="M3.5 14.5V2" />
    <path d="M3.5 2.5h8.5l-1.75 3 1.75 3H3.5" />
  </>,
);

export const FlagIcon = icon(
  <>
    <path d="M3.5 14.5V2" />
    <path d="M3.5 2.5h8.5l-1.75 3 1.75 3H3.5" />
  </>,
);
export const SegmentIcon = icon(
  <>
    <circle cx="6" cy="6.5" r="2.25" />
    <path d="M1.75 13.5a4.25 4.25 0 0 1 8.5 0" />
    <path d="M10.5 4.5a2.25 2.25 0 1 1 0 4.25M11.5 10a4 4 0 0 1 2.75 3.5" />
  </>,
);
export const LayersIcon = icon(
  <>
    <path d="m8 1.75 6.25 3.25L8 8.25 1.75 5z" />
    <path d="m1.75 8 6.25 3.25L14.25 8" />
    <path d="m1.75 11 6.25 3.25L14.25 11" />
  </>,
);
export const ExperimentIcon = icon(
  <>
    <path d="M6 1.75h4M6.5 1.75v4.5L2.5 13a1 1 0 0 0 .9 1.5h9.2a1 1 0 0 0 .9-1.5l-4-6.75v-4.5" />
    <path d="M4.25 10h7.5" />
  </>,
);
export const MetricIcon = icon(
  <>
    <path d="M2 14h12" />
    <path d="M4 11.5V8M7 11.5V4.5M10 11.5V6.5M13 11.5V2.5" />
  </>,
);
export const ApprovalIcon = icon(
  <>
    <path d="M8 1.75 2.75 4v4c0 3 2.25 5.5 5.25 6.25 3-.75 5.25-3.25 5.25-6.25V4z" />
    <path d="m5.75 8 1.75 1.75 3-3.25" />
  </>,
);
export const ActivityIcon = icon(<path d="M1.5 8h3l2-5 3 10 2-5h3" />);
export const EnvironmentIcon = icon(
  <>
    <circle cx="8" cy="8" r="6.25" />
    <path d="M1.75 8h12.5M8 1.75c1.75 1.75 2.5 3.75 2.5 6.25S9.75 12.5 8 14.25C6.25 12.5 5.5 10.5 5.5 8S6.25 3.5 8 1.75z" />
  </>,
);
export const HygieneIcon = icon(
  <>
    <path d="M9.5 1.75 6 8.5" />
    <path d="M3.5 8.5h6.25l1.25 5.75H2.25z" />
    <path d="M5.5 11v3.25M8 11v3.25" />
  </>,
);
export const OpsIcon = icon(
  <>
    <path d="M2.25 11.5a6 6 0 1 1 11.5 0" />
    <path d="m8 9.5 2.75-3.5" />
    <circle cx="8" cy="10" r="1" />
  </>,
);
