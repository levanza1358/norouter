# Verify change

Use this skill after any implementation or refactor.

## Checklist

1. Inspect the final diff and confirm no `.env`, database, WAL/SHM, credential, or generated screenshot changed.
2. Run syntax checks for touched JavaScript files, for example:

   ```bat
   node --check src\server.js
   ```

   Repeat for each touched `.js` file.
3. Run the existing suite:

   ```bat
   npm test
   ```

4. For dashboard work, start the server and check the affected route, asset loading, responsive layout, keyboard path, and error/empty states.
5. For provider/upstream work, use `test\stub-upstream.js`; never use real credentials.
6. State exactly what passed, failed, or was not run.

Do not weaken, delete, or skip an existing test merely to make a change pass.
