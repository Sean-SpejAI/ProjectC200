---
name: Nodak Elite InsurTech
colors:
  surface: '#f8f9ff'
  surface-dim: '#cbdbf5'
  surface-bright: '#f8f9ff'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#eff4ff'
  surface-container: '#e5eeff'
  surface-container-high: '#dce9ff'
  surface-container-highest: '#d3e4fe'
  on-surface: '#0b1c30'
  on-surface-variant: '#44474e'
  inverse-surface: '#213145'
  inverse-on-surface: '#eaf1ff'
  outline: '#75777e'
  outline-variant: '#c4c6ce'
  surface-tint: '#4c5f80'
  primary: '#000b21'
  on-primary: '#ffffff'
  primary-container: '#0d2240'
  on-primary-container: '#778aad'
  inverse-primary: '#b4c7ed'
  secondary: '#bb0021'
  on-secondary: '#ffffff'
  secondary-container: '#e02636'
  on-secondary-container: '#fffbff'
  tertiary: '#090d0e'
  on-tertiary: '#ffffff'
  tertiary-container: '#1f2325'
  on-tertiary-container: '#878a8c'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#d6e3ff'
  primary-fixed-dim: '#b4c7ed'
  on-primary-fixed: '#051b39'
  on-primary-fixed-variant: '#344767'
  secondary-fixed: '#ffdad7'
  secondary-fixed-dim: '#ffb3af'
  on-secondary-fixed: '#410005'
  on-secondary-fixed-variant: '#930018'
  tertiary-fixed: '#e0e3e5'
  tertiary-fixed-dim: '#c4c7c9'
  on-tertiary-fixed: '#191c1e'
  on-tertiary-fixed-variant: '#444749'
  background: '#f8f9ff'
  on-background: '#0b1c30'
  surface-variant: '#d3e4fe'
typography:
  display-lg:
    fontFamily: Inter
    fontSize: 32px
    fontWeight: '700'
    lineHeight: '1.2'
    letterSpacing: -0.02em
  headline-md:
    fontFamily: Inter
    fontSize: 24px
    fontWeight: '600'
    lineHeight: '1.3'
    letterSpacing: -0.01em
  headline-sm:
    fontFamily: Inter
    fontSize: 18px
    fontWeight: '600'
    lineHeight: '1.4'
  body-lg:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: '400'
    lineHeight: '1.6'
  body-md:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: '400'
    lineHeight: '1.5'
  label-md:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: '600'
    lineHeight: '1'
    letterSpacing: 0.05em
  label-sm:
    fontFamily: Inter
    fontSize: 11px
    fontWeight: '500'
    lineHeight: '1'
  headline-md-mobile:
    fontFamily: Inter
    fontSize: 20px
    fontWeight: '600'
    lineHeight: '1.3'
rounded:
  sm: 0.25rem
  DEFAULT: 0.5rem
  md: 0.75rem
  lg: 1rem
  xl: 1.5rem
  full: 9999px
spacing:
  base: 4px
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 32px
  gutter: 20px
  margin-mobile: 16px
  margin-desktop: 32px
---

## Brand & Style

The design system is engineered to evoke **trust, stability, and surgical precision**. As a premium insurance technology interface, it balances the traditional authority of the insurance sector with the streamlined efficiency of high-end SaaS. The visual language is deeply rooted in **Corporate Modernism**, prioritizing legibility and information density without sacrificing aesthetic refinement.

The target audience consists of adjusters, legal professionals, and analysts who require a tool that feels "heavy" enough to be reliable, yet "light" enough to use for hours without cognitive fatigue. The UI avoids unnecessary decorative elements, using whitespace and subtle depth to guide the user's eye through complex data structures. The emotional response is one of organized control and professional excellence.

## Colors

The palette is anchored by **Deep Navy (#0D2240)**, representing institutional trust and authority. **Corporate Red (#D71E30)** is used with extreme intentionality—only for primary actions, critical alerts, and brand signifiers—to ensure it retains its impact without overwhelming the user.

The foundation of the interface is built on a spectrum of **Light Grays and Off-Whites**. This creates a "layered" effect where the background is slightly darker than the primary work surfaces (cards and panels), establishing a clear sense of depth. Status colors (Success, Warning, Info) utilize high-chroma variants for icons paired with ultra-desaturated "tint" backgrounds to maintain a premium feel.

## Typography

This design system utilizes **Inter** for its neutral, highly legible, and versatile character. The typographic hierarchy is strictly enforced to manage data-heavy views.

- **Display & Headlines:** Use tighter letter spacing and heavier weights to project confidence.
- **Body Text:** Uses a slightly increased line height (1.5 - 1.6) to improve readability during long-form document review.
- **Labels:** Small caps or all-caps are used for metadata and table headers to create a distinct visual "texture" that differentiates them from interactive or primary content.
- **Color Application:** Primary headers use Navy, while secondary text uses a muted Slate Gray to diminish visual noise.

## Layout & Spacing

The system follows an **8px grid** with 4px sub-increments for fine-tuning. The layout is a **Hybrid Fluid Grid**:

- **Sidebar:** Fixed width (260px) to house primary navigation and system utilities.
- **Main Content Area:** Fluid, but with a maximum readable width for document containers to prevent line lengths from becoming too long.
- **Data Panels:** Utilize a 12-column system on desktop, collapsing to a single-stack layout on mobile.
- **Visual Rhythm:** Generous internal padding (24px) within cards provides the "premium" feel, ensuring that even dense insurance data does not feel cramped.

## Elevation & Depth

Hierarchy is established through **Tonal Layering** and **Soft Ambient Shadows**.

1.  **Level 0 (Background):** Light Gray (#F1F5F9). No shadow.
2.  **Level 1 (Main Surfaces/Cards):** Pure White (#FFFFFF). Very soft, diffused shadow: `0 4px 6px -1px rgb(0 0 0 / 0.05), 0 2px 4px -2px rgb(0 0 0 / 0.05)`.
3.  **Level 2 (Active States/Modals):** Pure White. Pronounced depth: `0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)`.

Backdrop blurs are reserved exclusively for navigation overlays or modal backdrops to maintain the "precision tool" aesthetic without becoming overly decorative.

## Shapes

The design system employs **Rounded (8px-12px)** corners to soften the professional interface, making it feel modern and approachable. 

- **Small Components (Buttons, Inputs):** 8px radius.
- **Large Components (Cards, Panels):** 12px-16px radius.
- **Feedback Elements (Chips, Tags):** Full pill-shape to distinguish them from actionable buttons.

This consistent radius creates a unified "container" language across all data modules.

## Components

### Buttons
- **Primary:** Solid Deep Navy with white text. High contrast, sharp focus.
- **Secondary:** White background, Navy border (1px), Navy text.
- **Actionable/Brand:** Solid Red is used only for "New" or critical "Call to Action" items.

### Cards
Cards are the primary container. They must feature a subtle border (#E2E8F0) and Level 1 elevation. Headers within cards should have a subtle bottom divider and a gray background tint (#F8FAFC) to separate the metadata from the body.

### Input Fields
Inputs use a white background with a 1px Slate-200 border. On focus, the border transitions to Navy with a subtle 3px outer glow in a semi-transparent navy.

### Chips & Badges
Badges for status (e.g., "Verified", "Pending") use a low-saturation background of the status color with a high-saturation text and icon color.

### Data Tables
Tables are "clean"—no vertical borders, only horizontal dividers in light gray. Row hover states use a subtle #F8FAFC tint.