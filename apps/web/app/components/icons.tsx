// Inline stroke icons (no icon-font or network requests).
import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 18, children, ...rest }: P & { children: React.ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
      {children}
    </svg>
  );
}

export const IconHeart = (p: P) => (<Svg {...p}><path d="M12 20s-7.5-4.6-7.5-10.2A4.3 4.3 0 0112 7.3a4.3 4.3 0 017.5 2.5C19.5 15.4 12 20 12 20z" /></Svg>);
export const IconUsers = (p: P) => (<Svg {...p}><path d="M16 20v-1.5a3.5 3.5 0 00-3.5-3.5h-5A3.5 3.5 0 004 18.5V20" /><circle cx="10" cy="8" r="3.5" /><path d="M20 20v-1.5a3.5 3.5 0 00-2.5-3.35M15.5 4.65a3.5 3.5 0 010 6.7" /></Svg>);
export const IconDoc = (p: P) => (<Svg {...p}><rect x="5" y="3.5" width="14" height="17" rx="2" /><path d="M8.5 8h7M8.5 12h7M8.5 16h4" /></Svg>);
export const IconHistory = (p: P) => (<Svg {...p}><path d="M3.5 12a8.5 8.5 0 102.5-6" /><path d="M3.5 4v4h4" /><path d="M12 8v4l2.5 2" /></Svg>);
export const IconMessage = (p: P) => (<Svg {...p}><path d="M4 5h16v11H9l-5 4z" /></Svg>);
export const IconSun = (p: P) => (<Svg {...p}><circle cx="12" cy="12" r="4" /><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4L6 18M18 6l1.4-1.4" /></Svg>);
export const IconMoon = (p: P) => (<Svg {...p}><path d="M20 14.5A8 8 0 019.5 4a8 8 0 1010.5 10.5z" /></Svg>);
export const IconMonitor = (p: P) => (<Svg {...p}><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></Svg>);
export const IconArrowRight = (p: P) => (<Svg {...p}><path d="M5 12h14M13 6l6 6-6 6" /></Svg>);
export const IconChevronDown = (p: P) => (<Svg {...p}><path d="M6 9l6 6 6-6" /></Svg>);
export const IconChevronRight = (p: P) => (<Svg {...p}><path d="M9 6l6 6-6 6" /></Svg>);
export const IconImage = (p: P) => (<Svg {...p}><rect x="3.5" y="3.5" width="17" height="17" rx="2.5" /><circle cx="9" cy="9" r="1.6" /><path d="M20.5 15.5l-4.5-4.5-9 9.5" /></Svg>);
export const IconClose = (p: P) => (<Svg {...p}><path d="M6 6l12 12M18 6L6 18" /></Svg>);
export const IconArrowUp = (p: P) => (<Svg {...p}><path d="M12 19V5M6 11l6-6 6 6" /></Svg>);
export const IconCheck = (p: P) => (<Svg {...p}><path d="M5 12.5l4.5 4.5L19 7.5" /></Svg>);
