# Deferred items

Out-of-scope discoveries logged during plan execution, per the executor's SCOPE BOUNDARY rule. Not fixed here.

## 22-06

- **`apps/web/src/lib/sentry.ts` fails `npm run lint`** with 4 `@typescript-eslint/no-unsafe-*` errors on `import.meta.env.*` member accesses (`.MODE`, `.VITE_SENTRY_RELEASE`, `.VITE_SENTRY_DSN`). Pre-existing, unrelated to this plan's changes (this plan touches only `packages/db`). Reproduces in this worktree because Vite's ambient `ImportMetaEnv` types are unresolvable here -- consistent with the documented worktree limitation "vite/Playwright are unresolvable in worktrees" (this project's `apps/web` has no local `vite`/`@vitejs/plugin-react` resolution path from inside a git worktree with no `node_modules` of its own). Not reproduced or fixed by this plan; verify against the main checkout (which has real `node_modules`) before treating as a real regression.
