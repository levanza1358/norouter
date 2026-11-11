# Release check

Use this skill before a commit, release, archive, or handoff.

## Checklist

- Read the final diff and confirm only intended source, test, and documentation files changed.
- Run `npm test` and any syntax checks required by touched JavaScript files.
- Confirm `README.md` and relevant `docs/` pages match the current routes, configuration, limitations, and security boundary.
- Confirm `.env`, database/WAL/SHM files, tokens, screenshots, temporary files, and runtime state are absent from the change.
- Preserve the no-dependency/no-build claim unless package files and instructions were intentionally updated.
- Check startup commands, Node runtime requirement, port/bind defaults, and test instructions.
- Report exactly what was verified and what could not be verified.

Do not call a change release-ready when tests or secret-safety checks are unrun.
