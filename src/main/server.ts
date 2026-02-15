/**
 * Standalone server entry point for claude-devtools web deployment.
 *
 * Replaces the Electron main process with a pure Node.js Fastify server.
 * No Electron dependency — runs anywhere Node.js runs.
 *
 * Environment variables:
 * - PORT: Server port (default: 3456)
 * - HOST: Bind address (default: 0.0.0.0 for Docker, 127.0.0.1 for local)
 * - CLAUDE_ROOT: Path to .claude directory (default: ~/.claude)
 * - CONFIG_DIR: Writable config directory (default: CLAUDE_ROOT)
 * - NOTIFICATIONS_DIR: Writable notifications directory (default: CLAUDE_ROOT)
 * - NODE_ENV: development | production
 */

import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { registerHttpRoutes } from '@main/http';
import { broadcastEvent } from '@main/http/events';
import {
  configManager,
  LocalFileSystemProvider,
  NotificationManager,
  ServiceContext,
  SshConnectionManager,
  UpdaterService,
} from '@main/services';
import { createLogger } from '@shared/utils/logger';
import Fastify from 'fastify';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';

const logger = createLogger('Server');

// =============================================================================
// Configuration
// =============================================================================

const PORT = parseInt(process.env.PORT ?? '3456', 10);
const HOST = process.env.HOST ?? '0.0.0.0';
const CLAUDE_ROOT = process.env.CLAUDE_ROOT ?? join(homedir(), '.claude');
const isDev = process.env.NODE_ENV === 'development';

// =============================================================================
// Server Setup
// =============================================================================

async function main(): Promise<void> {
  logger.info('Starting claude-devtools web server...');
  logger.info(`Claude root: ${CLAUDE_ROOT}`);
  logger.info(`Mode: ${isDev ? 'development' : 'production'}`);

  // Validate claude root exists
  if (!existsSync(CLAUDE_ROOT)) {
    logger.error(`Claude root directory not found: ${CLAUDE_ROOT}`);
    logger.error('Make sure ~/.claude exists or set CLAUDE_ROOT env var.');
    logger.error('For Docker: mount with -v ~/.claude:/home/node/.claude:ro');
    process.exit(1);
  }

  const projectsDir = join(CLAUDE_ROOT, 'projects');
  const todosDir = join(CLAUDE_ROOT, 'todos');

  if (!existsSync(projectsDir)) {
    logger.error(`Projects directory not found: ${projectsDir}`);
    logger.error('No Claude Code sessions found. Have you used Claude Code yet?');
    process.exit(1);
  }

  logger.info(`Projects directory: ${projectsDir}`);
  logger.info(`Todos directory: ${todosDir}`);

  // Create service context (same as Electron's local context)
  const serviceContext = new ServiceContext({
    id: 'local',
    type: 'local',
    fsProvider: new LocalFileSystemProvider(),
    projectsDir,
    todosDir,
  });
  serviceContext.start();

  // Create supporting services
  const sshConnectionManager = new SshConnectionManager();
  const updaterService = new UpdaterService();
  const notificationManager = NotificationManager.getInstance();
  serviceContext.fileWatcher.setNotificationManager(notificationManager);

  // Create Fastify server
  const app = Fastify({ logger: false });

  // CORS - allow all origins for Docker/remote deployments
  await app.register(cors, {
    origin: true,
    credentials: true,
  });

  // Serve static renderer files in production
  if (!isDev) {
    const candidates = [
      resolve(__dirname, '../../out/renderer'),     // electron-vite output
      resolve(__dirname, '../client'),               // web build output
      resolve(process.cwd(), 'dist/client'),         // fallback
    ];
    const clientDir = candidates.find((c) => existsSync(c));

    if (clientDir) {
      await app.register(fastifyStatic, {
        root: clientDir,
        prefix: '/',
        wildcard: false,
      });

      // SPA fallback
      app.setNotFoundHandler(async (request, reply) => {
        if (request.url.startsWith('/api/')) {
          return reply.status(404).send({ error: 'Not found' });
        }
        return reply.sendFile('index.html');
      });
      logger.info(`Serving static files from: ${clientDir}`);
    } else {
      logger.warn('Client build not found. Build with: pnpm build:web');
    }
  }

  // Register all API routes
  registerHttpRoutes(
    app,
    {
      projectScanner: serviceContext.projectScanner,
      sessionParser: serviceContext.sessionParser,
      subagentResolver: serviceContext.subagentResolver,
      chunkBuilder: serviceContext.chunkBuilder,
      dataCache: serviceContext.dataCache,
      updaterService,
      sshConnectionManager,
    },
    async () => {
      // Mode switch handler - no-op for standalone server
    }
  );

  // Health check endpoint
  app.get('/api/health', async () => ({
    status: 'ok',
    version: process.env.npm_package_version ?? '0.1.0',
    claudeRoot: CLAUDE_ROOT,
    uptime: process.uptime(),
  }));

  // Wire file watcher events to SSE
  serviceContext.fileWatcher.on('file-change', (event: unknown) => {
    broadcastEvent('file-change', event);
  });

  serviceContext.fileWatcher.on('todo-change', (event: unknown) => {
    broadcastEvent('todo-change', event);
  });

  notificationManager.on('notification-new', (notification: unknown) => {
    broadcastEvent('notification:new', notification);
  });
  notificationManager.on('notification-updated', (data: unknown) => {
    broadcastEvent('notification:updated', data);
  });

  // Start server
  try {
    await app.listen({ host: HOST, port: PORT });
    logger.info(`Server running at http://${HOST}:${PORT}`);
    if (isDev) {
      logger.info(`API available at http://localhost:${PORT}/api/`);
      logger.info(`Web UI dev server at http://localhost:5173`);
    } else {
      logger.info(`Open http://localhost:${PORT} in your browser`);
    }
  } catch (err) {
    logger.error('Failed to start server:', err);
    process.exit(1);
  }

  // Graceful shutdown
  const shutdown = async () => {
    logger.info('Shutting down...');
    serviceContext.dispose();
    sshConnectionManager.dispose();
    await app.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
