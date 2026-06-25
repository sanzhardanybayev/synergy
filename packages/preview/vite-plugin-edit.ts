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
import { handleAgentTreePut } from './src/server/agent-tree.js';
import { handleDiff } from './src/server/diff.js';
import { handleEdit } from './src/server/edit.js';
import { handleLog, handlePhase, handleResume } from './src/server/execstate.js';
import { handleFeedbackBatch } from './src/server/feedback-batch.js';
import {
  handleFeedbackGet,
  handleFeedbackPatch,
  handleFeedbackPost,
} from './src/server/feedback.js';
import { readJsonBody, sendJson } from './src/server/http.js';
import { handleProgress } from './src/server/progress.js';
import { handleReview } from './src/server/review.js';
import { handleScaffold } from './src/server/scaffold.js';
import { handleSource } from './src/server/source.js';
import { handleStatus } from './src/server/status.js';
import { handleValidate } from './src/server/validate.js';

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

          // PUT /api/agent-tree
          if (method === 'PUT' && pathname === '/api/agent-tree') {
            const body = await readJsonBody(req);
            const result = await handleAgentTreePut(sessionsDir, body as any);
            res.setHeader('content-type', 'application/json');
            res.statusCode = result.ok ? 200 : result.reason === 'not_found' ? 404 : 409;
            res.end(JSON.stringify(result));
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

          // POST /api/feedback/resolve-batch — resolve/reject many comments at once.
          // Must precede the `:id` matcher below (resolve-batch is a single segment).
          if (method === 'POST' && pathname === '/api/feedback/resolve-batch') {
            await handleFeedbackBatch(req, res, feedbackDir);
            return;
          }

          // PATCH /api/feedback/:id
          // Match exactly /api/feedback/<id> with no further slashes; never capture
          // the literal `resolve-batch` segment handled above.
          const feedbackPatchMatch = /^\/api\/feedback\/(?!resolve-batch$)([^/]+)$/.exec(pathname);
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

          // POST /api/phase — set execution-state phase status (+ optional note)
          if (method === 'POST' && pathname === '/api/phase') {
            await handlePhase(req, res, sessionsDir);
            return;
          }

          // POST /api/log — append a finding to a phase or the global journal
          if (method === 'POST' && pathname === '/api/log') {
            await handleLog(req, res, sessionsDir);
            return;
          }

          // POST /api/resume — write the hand-off pointer
          if (method === 'POST' && pathname === '/api/resume') {
            await handleResume(req, res, sessionsDir);
            return;
          }

          // GET /api/validate?session=<name?> — run cross-ref + schema validation
          if (method === 'GET' && pathname === '/api/validate') {
            handleValidate(req, res, projectRoot);
            return;
          }

          // POST /api/scaffold — create a session's dirs + files in one call
          if (method === 'POST' && pathname === '/api/scaffold') {
            await handleScaffold(req, res, sessionsDir);
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
