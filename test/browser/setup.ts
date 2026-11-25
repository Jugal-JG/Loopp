import type { FullConfig } from '@playwright/test';
import { createServer } from 'vite';

export default async function setup(config: FullConfig) {
  const { hostname, port } = new URL(config.projects[0].use.baseURL!);
  const server = await createServer({ server: { host: hostname, port: Number(port), strictPort: true } });
  await server.listen();
  return async () => { await server.close(); };
}
