/**
 * Vite plugin: synergy-edit
 *
 * Registers a Connect-style middleware that exposes the /api/* endpoints for
 * inline editing, status flipping, feedback comments, diff view, and
 * review-state management.
 *
 * Modeled on vite-plugin-sessions.ts. One configureServer -> one
 * middlewares.use. No router library - plain method + pathname matching.
 */
import { join } from 'node:path';
import type { Plugin } from 'vite';
import { handleActiveSession } from './src/server/active-session.js';
import { handleDiff } from './src/server/diff.js';
import { handleEdit } from './src/server/edit.js';
import {
  handleFeedbackGet,
  handleFeedbackPatch,
  handleFeedbackPost,
} from './src/server/feedback.js';
import { sendJson } from './src/server/http.js';
import { handleReview } from './src/server/review.js';
import { handleSource } from './src/server/source.js';
import { handleProgress } from './src/server/progress.js';
import { handleStatus } from './src/server/status.js';

interface PluginOptions {
  sessionsDir: string;
  projectRoot: string;
}

export function synergyEditPlugin(options: PluginOptions): Plugin {
  const { sessionsDir, projectRoot } = options;
  const feedbackDir = join(projectRoot, '.synergy', 'feedback');
  const synergyDir = join(projectRoot, '.synergy');

  return {
    name: 'synergy-edit',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const pathname = url.pathname;

        // Only intercept /api/* routes.
        if (!pathname.startsWith('/api/')) {
          next();
          return;
        }

        const method = req.method ?? '';

        try {
          // PUT /api/edit
          if (method === 'PUT' && pathname === '/api/edit') {
            await handleEdit(req, res, sessionsDir);
            return;
          }

          // PATCH /api/status
          if (method === 'PATCH' && pathname === '/api/status') {
            await handleStatus(req, res, sessionsDir);
            return;
          }

          // POST /api/feedback
          if (method === 'POST' && pathname === '/api/feedback') {
            await handleFeedbackPost(req, res, feedbackDir);
            return;
          }

          // GET /api/feedback
          if (method === 'GET' && pathname === '/api/feedback') {
            handleFeedbackGet(req, res, feedbackDir);
            return;
          }

          // PATCH /api/feedback/:id
          // Match exactly /api/feedback/<id> with no further slashes.
          const feedbackPatchMatch = /^\/api\/feedback\/([^/]+)$/.exec(pathname);
          if (method === 'PATCH' && feedbackPatchMatch) {
            const id = feedbackPatchMatch[1]!;
            await handleFeedbackPatch(req, res, feedbackDir, id);
            return;
          }

          // GET /api/source
          if (method === 'GET' && pathname === '/api/source') {
            handleSource(req, res, sessionsDir);
            return;
          }

          // GET /api/diff
          if (method === 'GET' && pathname === '/api/diff') {
            handleDiff(req, res, sessionsDir, projectRoot);
            return;
          }

          // GET /api/progress
          if (method === 'GET' && pathname === '/api/progress') {
            handleProgress(req, res, sessionsDir);
            return;
          }

          // POST /api/review
          if (method === 'POST' && pathname === '/api/review') {
            await handleReview(req, res, sessionsDir, projectRoot);
            return;
          }

          // POST /api/active-session
          if (method === 'POST' && pathname === '/api/active-session') {
            await handleActiveSession(req, res, synergyDir);
            return;
          }

          // No route matched under /api/*
          sendJson(res, 404, { error: 'no_route' });
        } catch (err) {
          // Guard: unexpected throw must not crash the dev server.
          sendJson(res, 500, {
            error: 'internal_error',
            detail: err instanceof Error ? err.message : String(err),
          });
        }
      });
    },
  };
}
