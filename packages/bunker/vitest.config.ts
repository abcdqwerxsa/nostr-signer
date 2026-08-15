import { defineConfig } from 'vitest/config'
import { cloudflareTest } from '@cloudflare/vitest-pool-workers'

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        compatibilityFlags: ['nodejs_compat'],
        // 测试环境显式注入，避免依赖部署 secret
        bindings: {
          BUNKER_KEK: 'a'.repeat(64),
          ADMIN_TOKEN: 'test-admin-token',
          DEFAULT_RELAYS: '',
        },
      },
    }),
  ],
})
