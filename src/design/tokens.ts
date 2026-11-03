/**
 * ArthaVault v3.0 Design System Tokens
 * Source of truth for color palettes, typography hierarchy, spacing scale, and container radii.
 */

export const ARTHAVAULT_TOKENS = {
  colors: {
    // Dark Canvas & Surface Hierarchy
    background: '#0D1117',        // Deep dark canvas
    surfaceCard: '#161B22',       // Primary card surface
    surfaceCardElevated: '#1F2937', // Elevated / hover card
    border: '#21262D',            // Default subtle border
    borderSubtle: '#30363D',      // Active / hover border

    // Brand & Functional Accents
    primary: '#4F8CFF',           // ArthaVault Blue
    primaryLight: '#6CA5FF',      // Accent Light Blue
    success: '#23C55E',           // Positive / Reconciled Green
    warning: '#F59E0B',           // Warning / Attention Amber
    danger: '#EF4444',            // Negative / Deficit Red
    info: '#06B6D4',              // Informational Cyan

    // Text Hierarchy
    textPrimary: '#F0F6FC',       // High-contrast primary text
    textSecondary: '#8B949E',     // Muted secondary text
    textTertiary: '#6E7681'       // Placeholder / disabled text
  },
  typography: {
    fontFamily: 'Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    heading1: 'text-2xl md:text-3xl font-extrabold tracking-tight',
    heading2: 'text-xl md:text-2xl font-bold tracking-tight',
    heading3: 'text-base md:text-lg font-bold tracking-tight',
    bodyLarge: 'text-base font-normal',
    bodyRegular: 'text-sm font-normal',
    caption: 'text-xs font-medium',
    badge: 'text-[11px] font-bold uppercase tracking-wider'
  },
  spacing: {
    sidebarWidth: '240px',
    sidebarCollapsedWidth: '72px',
    headerHeight: '64px',
    contentPadding: '24px'
  },
  radii: {
    sm: 'rounded-lg',             // 8px
    card: 'rounded-2xl',          // 12px-16px
    chart: 'rounded-3xl',         // 20px-24px
    full: 'rounded-full'          // 9999px
  },
  transitions: {
    fast: 'transition-all duration-150 ease-in-out',
    normal: 'transition-all duration-200 ease-in-out',
    smooth: 'transition-all duration-300 cubic-bezier(0.4, 0, 0.2, 1)'
  }
} as const;

/** Backward-compatible token alias preserved for existing consumers. */
export const FINBOOM_TOKENS = ARTHAVAULT_TOKENS;
