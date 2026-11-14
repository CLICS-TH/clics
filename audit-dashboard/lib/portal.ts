// The physician-ui Portal is the one sign-in screen for every role. It shares this origin (Portal at /,
// dashboard at /audit), so the default is a same-origin path. Next inlines NEXT_PUBLIC_PORTAL_URL at build
// time only when it is referenced literally.
const ORIGIN = (process.env.NEXT_PUBLIC_PORTAL_URL || '').replace(/\/+$/, '');

export const PORTAL = {
  login: `${ORIGIN}/login`,
  logout: `${ORIGIN}/login?logout=1`,
  dashboard: `${ORIGIN}/dashboard`,
} as const;
