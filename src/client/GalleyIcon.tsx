/**
 * dsh-galley — pane glyph (M0): a typeset A4 page with a margin line —
 * "Druck und Satz". Drawn on `currentColor` so the chip and the guide
 * capsule pick their own ink. Inline SVG only.
 */
import type { CSSProperties, ReactNode } from 'react'

export interface GalleyIconProps {
  size?: number
  className?: string
  style?: CSSProperties
}

export function GalleyIcon({ size = 16, className, style }: GalleyIconProps): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      className={className}
      style={style}
    >
      {/* page */}
      <rect x="3.5" y="2" width="9" height="12" rx="1" stroke="currentColor" />
      {/* margin (line-number) gutter tick */}
      <path d="M5.2 4.5H6" stroke="currentColor" strokeLinecap="round" />
      <path d="M5.2 6.8H6" stroke="currentColor" strokeLinecap="round" />
      <path d="M5.2 9.1H6" stroke="currentColor" strokeLinecap="round" />
      {/* text lines */}
      <path d="M7 4.5H11" stroke="currentColor" strokeLinecap="round" />
      <path d="M7 6.8H11" stroke="currentColor" strokeLinecap="round" />
      <path d="M7 9.1H10" stroke="currentColor" strokeLinecap="round" />
    </svg>
  )
}
