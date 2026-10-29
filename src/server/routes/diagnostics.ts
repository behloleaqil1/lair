/**
 * Diagnostics REST API routes (Fastify)
 * See SPEC-diagnostics.md for specification
 */

import type { FastifyInstance } from 'fastify';
import { 
  getDiagnosticsEngine, 
  ALL_PATTERNS, 
  ALL_PLAYBOOKS,
  getPlaybook,
} from '../diagnostics/index.js';

interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  timestamp: string;
}

function respond<T>(data: T): ApiResponse<T> {
  return {
    success: true,
    data,
    timestamp: new Date().toISOString(),
  };
}

function respondError(error: string): ApiResponse<never> {
  return {
    success: false,
    error,
    timestamp: new Date().toISOString(),
  };
}

export async function registerDiagnosticsRoutes(fastify: FastifyInstance): Promise<void> {
  
  // GET /api/diagnostics/health - Get health status for all components
  fastify.get('/api/diagnostics/health', async () => {
    try {
      const engine = getDiagnosticsEngine();
      const statuses = engine.getHealthStatuses();
      const overall = statuses.every(s => s.healthy);
      
      return respond({
        healthy: overall,
        components: statuses,
      });
    } catch (error) {
      return respondError(String(error));
    }
  });

  // GET /api/diagnostics/diagnoses - Get all diagnoses
  fastify.get<{ Querystring: { state?: string; category?: string; severity?: string; limit?: string } }>(
    '/api/diagnostics/diagnoses',
    async (request) => {
      try {
        const engine = getDiagnosticsEngine();
        const { state, category, severity, limit = '50' } = request.query;
        
        let diagnoses = engine.getActiveDiagnoses();
        
        if (state) diagnoses = diagnoses.filter(d => d.state === state);
        if (category) diagnoses = diagnoses.filter(d => d.category === category);
        if (severity) diagnoses = diagnoses.filter(d => d.severity === severity);
        
        diagnoses.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
        diagnoses = diagnoses.slice(0, parseInt(limit, 10));
        
        return respond({ diagnoses });
      } catch (error) {
        return respondError(String(error));
      }
    }
  );

  // GET /api/diagnostics/diagnoses/:id - Get a specific diagnosis
  fastify.get<{ Params: { id: string } }>(
    '/api/diagnostics/diagnoses/:id',
    async (request, reply) => {
      try {
        const engine = getDiagnosticsEngine();
        const diagnosis = engine.getDiagnosis(request.params.id);
        
        if (!diagnosis) {
          reply.status(404);
          return respondError('Diagnosis not found');
        }
        
        return respond({ diagnosis });
      } catch (error) {
        return respondError(String(error));
      }
    }
  );

  // GET /api/diagnostics/escalations - Get all escalations
  fastify.get<{ Querystring: { state?: string; severity?: string; limit?: string } }>(
    '/api/diagnostics/escalations',
    async (request) => {
      try {
        const engine = getDiagnosticsEngine();
        const { state, severity, limit = '50' } = request.query;
        
        let escalations = engine.getPendingEscalations();
        
        if (state === 'all') {
          escalations = Array.from((engine as unknown as { escalations: Map<string, typeof escalations[0]> }).escalations.values());
        } else if (state) {
          escalations = escalations.filter(e => e.state === state);
        }
        
        if (severity) escalations = escalations.filter(e => e.severity === severity);
        
        escalations.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
        escalations = escalations.slice(0, parseInt(limit, 10));
        
        return respond({ escalations });
      } catch (error) {
        return respondError(String(error));
      }
    }
  );

  // GET /api/diagnostics/escalations/:id - Get a specific escalation
  fastify.get<{ Params: { id: string } }>(
    '/api/diagnostics/escalations/:id',
    async (request, reply) => {
      try {
        const engine = getDiagnosticsEngine();
        const escalation = engine.getEscalation(request.params.id);
        
        if (!escalation) {
          reply.status(404);
          return respondError('Escalation not found');
        }
        
        return respond({ escalation });
      } catch (error) {
        return respondError(String(error));
      }
    }
  );

  // POST /api/diagnostics/escalations/:id/acknowledge - Acknowledge an escalation
  fastify.post<{ Params: { id: string } }>(
    '/api/diagnostics/escalations/:id/acknowledge',
    async (request, reply) => {
      try {
        const engine = getDiagnosticsEngine();
        const escalation = engine.acknowledgeEscalation(request.params.id);
        
        if (!escalation) {
          reply.status(404);
          return respondError('Escalation not found');
        }
        
        return respond({ escalation });
      } catch (error) {
        return respondError(String(error));
      }
    }
  );

  // POST /api/diagnostics/escalations/:id/resolve - Resolve an escalation
  fastify.post<{ Params: { id: string }; Body: { resolution: string } }>(
    '/api/diagnostics/escalations/:id/resolve',
    async (request, reply) => {
      try {
        const { resolution } = request.body;
        
        if (!resolution) {
          reply.status(400);
          return respondError('Resolution message required');
        }
        
        const engine = getDiagnosticsEngine();
        const escalation = engine.resolveEscalation(request.params.id, resolution);
        
        if (!escalation) {
          reply.status(404);
          return respondError('Escalation not found');
        }
        
        return respond({ escalation });
      } catch (error) {
        return respondError(String(error));
      }
    }
  );

  // POST /api/diagnostics/escalations/:id/dismiss - Dismiss an escalation
  fastify.post<{ Params: { id: string } }>(
    '/api/diagnostics/escalations/:id/dismiss',
    async (request, reply) => {
      try {
        const engine = getDiagnosticsEngine();
        const escalation = engine.dismissEscalation(request.params.id);
        
        if (!escalation) {
          reply.status(404);
          return respondError('Escalation not found');
        }
        
        return respond({ escalation });
      } catch (error) {
        return respondError(String(error));
      }
    }
  );

  // POST /api/diagnostics/escalations/:id/approve-playbook - Approve and run a recovery playbook
  fastify.post<{ Params: { id: string }; Body: { playbookId: string } }>(
    '/api/diagnostics/escalations/:id/approve-playbook',
    async (request, reply) => {
      try {
        const { playbookId } = request.body;
        
        if (!playbookId) {
          reply.status(400);
          return respondError('Playbook ID required');
        }
        
        const engine = getDiagnosticsEngine();
        const attempt = await engine.approvePlaybook(request.params.id, playbookId);
        
        if (!attempt) {
          reply.status(404);
          return respondError('Escalation or playbook not found');
        }
        
        return respond({ recovery: attempt });
      } catch (error) {
        return respondError(String(error));
      }
    }
  );

  // POST /api/diagnostics/diagnose-gate - Manually trigger diagnosis of a gate failure
  fastify.post<{ Body: { gateId: string; logPath: string } }>(
    '/api/diagnostics/diagnose-gate',
    async (request, reply) => {
      try {
        const { gateId, logPath } = request.body;
        
        if (!gateId || !logPath) {
          reply.status(400);
          return respondError('gateId and logPath required');
        }
        
        const engine = getDiagnosticsEngine();
        const diagnosis = await engine.diagnoseGateFailure(gateId, logPath);
        
        return respond({ diagnosis });
      } catch (error) {
        return respondError(String(error));
      }
    }
  );

  // POST /api/diagnostics/diagnose-agent - Manually trigger diagnosis of an agent failure
  fastify.post<{ Body: { agentId: string; logPath?: string; exitCode?: number } }>(
    '/api/diagnostics/diagnose-agent',
    async (request, reply) => {
      try {
        const { agentId, logPath, exitCode } = request.body;
        
        if (!agentId) {
          reply.status(400);
          return respondError('agentId required');
        }
        
        const engine = getDiagnosticsEngine();
        const diagnosis = await engine.diagnoseAgentFailure(agentId, logPath, exitCode);
        
        return respond({ diagnosis });
      } catch (error) {
        return respondError(String(error));
      }
    }
  );

  // GET /api/diagnostics/patterns - Get all diagnostic patterns
  fastify.get('/api/diagnostics/patterns', async () => {
    try {
      const patterns = ALL_PATTERNS.map(p => ({
        id: p.id,
        name: p.name,
        description: p.description,
        category: p.category,
        severity: p.severity,
        autoRecoverable: p.autoRecoverable,
        recoveryPlaybookId: p.recoveryPlaybookId,
      }));
      
      return respond({ patterns });
    } catch (error) {
      return respondError(String(error));
    }
  });

  // GET /api/diagnostics/playbooks - Get all recovery playbooks
  fastify.get('/api/diagnostics/playbooks', async () => {
    try {
      const playbooks = ALL_PLAYBOOKS.map(p => ({
        id: p.id,
        name: p.name,
        description: p.description,
        forPatterns: p.forPatterns,
        maxAttempts: p.maxAttempts,
        cooldownSeconds: p.cooldownSeconds,
        requiresApproval: p.requiresApproval,
        stepsCount: p.steps.length,
      }));
      
      return respond({ playbooks });
    } catch (error) {
      return respondError(String(error));
    }
  });

  // GET /api/diagnostics/playbooks/:id - Get a specific playbook
  fastify.get<{ Params: { id: string } }>(
    '/api/diagnostics/playbooks/:id',
    async (request, reply) => {
      try {
        const playbook = getPlaybook(request.params.id);
        
        if (!playbook) {
          reply.status(404);
          return respondError('Playbook not found');
        }
        
        return respond({ playbook });
      } catch (error) {
        return respondError(String(error));
      }
    }
  );

  // POST /api/diagnostics/run-playbook - Manually run a playbook
  fastify.post<{ Body: { playbookId: string } }>(
    '/api/diagnostics/run-playbook',
    async (request, reply) => {
      try {
        const { playbookId } = request.body;
        
        if (!playbookId) {
          reply.status(400);
          return respondError('playbookId required');
        }
        
        const playbook = getPlaybook(playbookId);
        if (!playbook) {
          reply.status(404);
          return respondError('Playbook not found');
        }
        
        if (playbook.requiresApproval) {
          reply.status(400);
          return respondError('This playbook requires approval. Use the escalation flow.');
        }
        
        const engine = getDiagnosticsEngine();
        
        // Create a synthetic diagnosis for manual runs
        const diagnosis = {
          id: `manual-${Date.now()}`,
          timestamp: new Date(),
          state: 'recovering' as const,
          category: 'infra' as const,
          severity: 'medium' as const,
          evidence: [],
          affected: [],
          autoRecoverable: true,
          rootCause: `Manual run of ${playbook.name}`,
        };
        
        const attempt = await engine.attemptRecovery(diagnosis, playbook);
        
        return respond({ recovery: attempt });
      } catch (error) {
        return respondError(String(error));
      }
    }
  );

  // POST /api/diagnostics/run-health-checks - Manually trigger health checks
  fastify.post('/api/diagnostics/run-health-checks', async () => {
    try {
      const engine = getDiagnosticsEngine();
      const statuses = await engine.runHealthChecks();
      
      return respond({ statuses });
    } catch (error) {
      return respondError(String(error));
    }
  });
}
