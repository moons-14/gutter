import { defineConfig, devices } from '@playwright/test';

const chromeExecutable = process.env.GUTTER_CHROME_EXECUTABLE;

export default defineConfig({
  testDir: './tests/e2e',
  // Four workers is the validated cap for the shared Vite web server and hydration.
  workers: 4,
  use: { baseURL: 'http://127.0.0.1:4173', serviceWorkers: 'block' },
  webServer: {
    command: 'corepack pnpm --filter @gutter/web exec vite dev --host 127.0.0.1 --port 4173',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    {
      name: 'chrome',
      use: {
        ...devices['Desktop Chrome'],
        ...(chromeExecutable
          ? { launchOptions: { executablePath: chromeExecutable } }
          : { channel: 'chrome' }),
      },
    },
  ],
});
