# UI polish

Use this skill for dashboard layout, styling, accessibility, and browser behavior.

## Rules

- Keep the existing vanilla HTML/CSS/JavaScript stack. Do not introduce React, Tailwind, a bundler, or a dependency for cosmetic work.
- Read the affected page markup, render function, and CSS before editing.
- Reuse the existing theme and accent tokens. Prefer CSS/native browser features over JavaScript.
- Preserve the current client-side routes and API contracts.
- Design for the documented 1280×720–1920×1080 range, then keep smaller screens usable.
- Keep keyboard focus visible, controls labeled, contrast readable, and status changes accessible.
- Support loading, empty, error, and success states where the affected view can encounter them.
- Respect `prefers-reduced-motion`; never make information depend on animation.
- Escape server/user text before inserting it into HTML. Do not render credentials or raw tokens.

## Verify

- Check every affected route at the running server, including a narrow viewport when layout changes.
- Run `npm test` after the change.
- Keep screenshots local and out of source changes.
