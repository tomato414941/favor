import type { Config } from '@react-router/dev/config';

export default {
  appDirectory: 'app',
  ssr: true,
  // Every page is known up front, so navigation never waits on route discovery.
  routeDiscovery: { mode: 'initial' },
} satisfies Config;
