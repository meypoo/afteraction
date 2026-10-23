import type { ReactNode, SVGProps } from "react";

/** One 16px icon set, 1.5px stroke, round joins. Drawn here so the UI ships no icon library. */
function Svg({ children, ...props }: SVGProps<SVGSVGElement> & { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={16}
      height={16}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...props}
    >
      {children}
    </svg>
  );
}

type P = SVGProps<SVGSVGElement>;

export const Icon = {
  Person: (p: P) => <Svg {...p}><circle cx="8" cy="5.5" r="2.5" /><path d="M3 13.5c.8-2.4 2.7-3.5 5-3.5s4.2 1.1 5 3.5" /></Svg>,
  Message: (p: P) => <Svg {...p}><path d="M2.5 4.5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v4.5a2 2 0 0 1-2 2H7l-3 2.5v-2.5h0a1.5 1.5 0 0 1-1.5-1.5Z" /></Svg>,
  Thought: (p: P) => <Svg {...p}><path d="M4.5 9.5a3 3 0 0 1 .4-5.97A3.5 3.5 0 0 1 11.6 4a2.75 2.75 0 0 1-.1 5.5Z" /><circle cx="5" cy="12.5" r="1" /><circle cx="2.75" cy="14.25" r=".5" /></Svg>,
  Terminal: (p: P) => <Svg {...p}><rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" /><path d="m4.75 6.25 2 1.75-2 1.75M8.5 10h2.75" /></Svg>,
  FileRead: (p: P) => <Svg {...p}><path d="M9.5 1.75H4.25a1.5 1.5 0 0 0-1.5 1.5v9.5a1.5 1.5 0 0 0 1.5 1.5h7.5a1.5 1.5 0 0 0 1.5-1.5V5.5Z" /><path d="M9.5 1.75V5.5h3.75M5.5 8.5h5M5.5 11h3" /></Svg>,
  FileWrite: (p: P) => <Svg {...p}><path d="M9.5 1.75H4.25a1.5 1.5 0 0 0-1.5 1.5v9.5a1.5 1.5 0 0 0 1.5 1.5h7.5a1.5 1.5 0 0 0 1.5-1.5V5.5Z" /><path d="M9.5 1.75V5.5h3.75M8 7.5v4M6 9.5h4" /></Svg>,
  Edit: (p: P) => <Svg {...p}><path d="M10.25 2.75a1.77 1.77 0 0 1 2.5 2.5L5.5 12.5l-3.25.75.75-3.25Z" /><path d="m9.25 3.75 2.5 2.5" /></Svg>,
  Globe: (p: P) => <Svg {...p}><circle cx="8" cy="8" r="6" /><path d="M2 8h12M8 2c1.7 1.6 2.5 3.6 2.5 6S9.7 12.4 8 14C6.3 12.4 5.5 10.4 5.5 8S6.3 3.6 8 2Z" /></Svg>,
  Agent: (p: P) => <Svg {...p}><rect x="3" y="5" width="10" height="8" rx="2" /><path d="M8 5V2.75M6 9h.01M10 9h.01M1.5 8.5v2M14.5 8.5v2" /></Svg>,
  Flag: (p: P) => <Svg {...p}><path d="M3.5 14V2.5M3.5 2.75h7.25l-1.5 3 1.5 3H3.5" /></Svg>,
  Tool: (p: P) => <Svg {...p}><path d="M9.6 2.4a3.25 3.25 0 0 0 3.97 3.97L7.4 12.6a1.6 1.6 0 1 1-2.25-2.25Z" transform="rotate(0)" /></Svg>,
  Return: (p: P) => <Svg {...p}><path d="M13 3.5v3.75a2 2 0 0 1-2 2H3.5M6 6.5 3.25 9.25 6 12" /></Svg>,
  Alert: (p: P) => <Svg {...p}><path d="M7.13 2.5a1 1 0 0 1 1.74 0l5.4 9.5a1 1 0 0 1-.87 1.5H2.6a1 1 0 0 1-.87-1.5Z" /><path d="M8 6.5v3M8 11.5h.01" /></Svg>,
  Dot: (p: P) => <Svg {...p}><circle cx="8" cy="8" r="1.5" fill="currentColor" /></Svg>,
  X: (p: P) => <Svg {...p}><path d="m4.5 4.5 7 7M11.5 4.5l-7 7" /></Svg>,
  Check: (p: P) => <Svg {...p}><path d="m3.5 8.5 3 3 6-7" /></Svg>,
  Play: (p: P) => <Svg {...p}><path d="M5 3.25v9.5L12.5 8Z" fill="currentColor" /></Svg>,
  Pause: (p: P) => <Svg {...p}><path d="M5.5 3.5v9M10.5 3.5v9" strokeWidth={2} /></Svg>,
  Search: (p: P) => <Svg {...p}><circle cx="7" cy="7" r="4.25" /><path d="m10.25 10.25 3.25 3.25" /></Svg>,
  Back: (p: P) => <Svg {...p}><path d="M9.5 3.5 5 8l4.5 4.5" /></Svg>,
  Copy: (p: P) => <Svg {...p}><rect x="5.25" y="5.25" width="8" height="8" rx="1.5" /><path d="M10.75 5.25v-1a1.5 1.5 0 0 0-1.5-1.5h-5a1.5 1.5 0 0 0-1.5 1.5v5a1.5 1.5 0 0 0 1.5 1.5h1" /></Svg>,
  Eye: (p: P) => <Svg {...p}><path d="M1.75 8S4 3.75 8 3.75 14.25 8 14.25 8 12 12.25 8 12.25 1.75 8 1.75 8Z" /><circle cx="8" cy="8" r="2" /></Svg>,
  Code: (p: P) => <Svg {...p}><path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5" /></Svg>,
  Lock: (p: P) => <Svg {...p}><rect x="3" y="7" width="10" height="7" rx="1.5" /><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" /></Svg>,
  Chevron: (p: P) => <Svg {...p}><path d="m6 4 4 4-4 4" /></Svg>,
  ChevronDown: (p: P) => <Svg {...p}><path d="m4.5 6 3.5 3.5L11.5 6" /></Svg>,
};

export type IconName = keyof typeof Icon;

/** The brand mark: a black-box recorder in international orange, with a trace line through it. */
export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden>
      <rect x="1.5" y="3.5" width="21" height="17" rx="4.5" fill="var(--color-brand)" />
      <rect x="1.5" y="3.5" width="21" height="17" rx="4.5" fill="url(#fr-sheen)" opacity="0.35" />
      <path d="M4.5 13h3l1.6-4.2 2.6 7.4 2.1-5.2 1.2 2H19.5" fill="none" stroke="#1a0c06" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      <defs>
        <linearGradient id="fr-sheen" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
      </defs>
    </svg>
  );
}
