import { defineConfig } from "@playwright/test";
import { getMigrationsDir } from "@mega-crm/test-support";

// Loading the shared database fixture is the regression target. The real E2E
// config imports the same package before it can provision its ephemeral DB.
void getMigrationsDir;

export default defineConfig({
  testDir: "../src/__tests__/fixtures/playwright-source-import",
});
