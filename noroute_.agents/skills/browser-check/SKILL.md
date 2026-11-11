# Browser check

Use this skill for dashboard routes, layout, interaction, rendering, or client-side API behavior.

## Checklist

- Check the affected route plus the shared shell and asset loading.
- Check normal, narrow, loading, empty, error, and long-content states when applicable.
- Check keyboard focus, button labels, form submission, and visible error feedback.
- Check the browser console for JavaScript errors and failed requests.
- Check `prefers-reduced-motion` and confirm no information depends on animation.
- Confirm server/user text is escaped and credentials remain masked.
- Use the running local server and synthetic data; keep screenshots out of source changes.

## Verify

Run `npm test` and perform a manual browser check for the affected page. Record pages or checks not available in the current environment instead of assuming they passed.
