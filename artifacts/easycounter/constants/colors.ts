/**
 * Semantic design tokens for the mobile app.
 *
 * These tokens mirror the naming conventions used in web artifacts (index.css)
 * so that multi-artifact projects share a cohesive visual identity.
 *
 * Replace the placeholder values below with values that match the project's
 * brand. If a sibling web artifact exists, read its index.css and convert the
 * HSL values to hex so both artifacts use the same palette.
 *
 * To add dark mode, add a `dark` key with the same token names.
 * The useColors() hook will automatically pick it up.
 */

const colors = {
  light: {
    // Legacy aliases (kept for backward compatibility)
    text: '#17252d',
    tint: '#e66b55',

    // Core surfaces
    background: '#f5f3ed',
    foreground: '#17252d',

    // Cards / elevated surfaces
    card: '#fffefa',
    cardForeground: '#17252d',

    // Primary action color (buttons, links, active states)
    primary: '#213a3b',
    primaryForeground: '#fffefa',

    // Secondary / less-emphasis interactive surfaces
    secondary: '#e9e7df',
    secondaryForeground: '#304244',

    // Muted / subdued elements (dividers, timestamps, placeholders)
    muted: '#eceae3',
    mutedForeground: '#777d78',

    // Accent highlights (badges, selected items, focus rings)
    accent: '#f6dfd6',
    accentForeground: '#a64737',

    // Destructive actions (delete, error states)
    destructive: '#b8483b',
    destructiveForeground: '#ffffff',

    // Borders and input outlines
    border: '#e1ded5',
    input: '#d8d5cb',
  },
  dark: {
    text: '#f5f3ed',
    tint: '#f0846f',
    background: '#151e20',
    foreground: '#f5f3ed',
    card: '#1e292a',
    cardForeground: '#f5f3ed',
    primary: '#d6e5dc',
    primaryForeground: '#182728',
    secondary: '#293536',
    secondaryForeground: '#e2e9e3',
    muted: '#293536',
    mutedForeground: '#a0aaa3',
    accent: '#50342f',
    accentForeground: '#ffc1ad',
    destructive: '#ff8b7c',
    destructiveForeground: '#291a18',
    border: '#354344',
    input: '#465251',
  },

  // Border radius (in px). Sync from the sibling web artifact's --radius
  // CSS variable. This value applies to cards, buttons, inputs, and modals.
  radius: 8,
};

export default colors;
