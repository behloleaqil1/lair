/**
 * Gate pipeline configuration loader.
 * Parses and validates pipeline configs from YAML or JSON.
 */
import { z } from "zod";
import type { GatePipeline, GateStep, ProjectGateConfig } from "../../shared/policy-types.js";

// ============ SCHEMAS ============

const GateStepSchema = z.object({
  name: z.string().min(1),
  command: z.string().min(1),
  timeoutSeconds: z.number().int().positive().default(300),
  requires: z.array(z.string()).optional(),
  continueOnFailure: z.boolean().optional(),
  env: z.record(z.string()).optional(),
});

const GateScopeRuleSchema = z.object({
  patterns: z.array(z.string().min(1)).min(1),
  steps: z.array(z.string().min(1)).min(1),
});

const GatePipelineSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  steps: z.array(GateStepSchema).min(1),
  scope: z.array(GateScopeRuleSchema).default([]),
  defaultSteps: z.array(z.string()).min(1),
  image: z.string().optional(),
  timeoutSeconds: z.number().int().positive().default(3600),
});

const ProjectGateConfigSchema = z.object({
  projectId: z.string().min(1),
  pipelines: z.array(GatePipelineSchema).min(1),
  defaultPipeline: z.string().min(1),
});

// ============ PARSING ============

/**
 * Parse and validate a gate step.
 */
export function parseGateStep(input: unknown): GateStep {
  return GateStepSchema.parse(input);
}

/**
 * Parse and validate a gate pipeline.
 */
export function parseGatePipeline(input: unknown): GatePipeline {
  const parsed = GatePipelineSchema.parse(input);
  
  // Validate that defaultSteps reference existing steps
  const stepNames = new Set(parsed.steps.map(s => s.name));
  for (const stepName of parsed.defaultSteps) {
    if (!stepNames.has(stepName)) {
      throw new Error(`Default step "${stepName}" not found in pipeline steps`);
    }
  }
  
  // Validate that scope rules reference existing steps
  for (const rule of parsed.scope) {
    for (const stepName of rule.steps) {
      if (!stepNames.has(stepName)) {
        throw new Error(`Scope rule references unknown step "${stepName}"`);
      }
    }
  }
  
  return parsed as GatePipeline;
}

/**
 * Parse and validate a project gate config.
 */
export function parseProjectGateConfig(input: unknown): ProjectGateConfig {
  const parsed = ProjectGateConfigSchema.parse(input);
  
  // Validate that defaultPipeline exists
  const pipelineIds = new Set(parsed.pipelines.map(p => p.id));
  if (!pipelineIds.has(parsed.defaultPipeline)) {
    throw new Error(`Default pipeline "${parsed.defaultPipeline}" not found`);
  }
  
  return parsed as ProjectGateConfig;
}

// ============ SCOPE COMPUTATION ============

/**
 * Match a file path against a glob pattern.
 * Simple implementation: supports *, **, and ?
 */
export function matchGlob(pattern: string, path: string): boolean {
  // Convert glob pattern to regex
  // Handle ** (match zero or more directory levels) specially
  let regex = pattern
    // First handle ? which in glob matches single char
    .replace(/\?/g, "<<<QUESTION>>>")
    .replace(/\./g, "\\.")
    .replace(/\*\*\//g, "<<<DOUBLESTAR_SLASH>>>")
    .replace(/\*\*/g, "<<<DOUBLESTAR>>>")
    .replace(/\*/g, "[^/]*")
    .replace(/<<<DOUBLESTAR_SLASH>>>/g, "(.*/)?")
    .replace(/<<<DOUBLESTAR>>>/g, ".*")
    .replace(/<<<QUESTION>>>/g, ".");
  
  regex = `^${regex}$`;
  
  try {
    return new RegExp(regex).test(path);
  } catch {
    return false;
  }
}

/**
 * Compute which steps should run based on changed files.
 */
export function computeAffectedSteps(
  pipeline: GatePipeline,
  changedFiles: string[]
): string[] {
  const affectedSteps = new Set<string>();
  
  // Check each scope rule
  for (const rule of pipeline.scope) {
    const matches = changedFiles.some(file =>
      rule.patterns.some(pattern => matchGlob(pattern, file))
    );
    
    if (matches) {
      for (const step of rule.steps) {
        affectedSteps.add(step);
      }
    }
  }
  
  // If no scope rules matched, use default steps
  if (affectedSteps.size === 0) {
    for (const step of pipeline.defaultSteps) {
      affectedSteps.add(step);
    }
  }
  
  // Return steps in pipeline order
  return pipeline.steps
    .filter(s => affectedSteps.has(s.name))
    .map(s => s.name);
}

/**
 * Generate a version hash for a pipeline config.
 * Used to detect if the pipeline changed between runs.
 */
export function computePipelineVersion(pipeline: GatePipeline): string {
  const content = JSON.stringify({
    id: pipeline.id,
    steps: pipeline.steps.map(s => ({
      name: s.name,
      command: s.command,
      timeoutSeconds: s.timeoutSeconds,
      requires: s.requires,
    })),
    scope: pipeline.scope,
    defaultSteps: pipeline.defaultSteps,
    image: pipeline.image,
  });
  
  // Simple hash (not cryptographic, just for change detection)
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  
  return Math.abs(hash).toString(16).padStart(8, "0");
}

// ============ EXAMPLE PIPELINE ============

/**
 * Create an example pipeline for documentation/testing.
 */
export function createExamplePipeline(): GatePipeline {
  return {
    id: "example-backend",
    name: "Example Backend Pipeline",
    steps: [
      {
        name: "lint",
        command: "npm run lint",
        timeoutSeconds: 120,
      },
      {
        name: "typecheck",
        command: "npm run typecheck",
        timeoutSeconds: 180,
      },
      {
        name: "unit-tests",
        command: "npm test",
        timeoutSeconds: 300,
      },
      {
        name: "integration-tests",
        command: "npm run test:integration",
        timeoutSeconds: 600,
        requires: ["docker"],
      },
      {
        name: "security-scan",
        command: "npm audit --audit-level=high",
        timeoutSeconds: 120,
        continueOnFailure: true,
      },
    ],
    scope: [
      {
        patterns: ["src/**/*.ts", "src/**/*.tsx"],
        steps: ["lint", "typecheck", "unit-tests"],
      },
      {
        patterns: ["src/server/**/*.ts", "src/db/**/*.ts"],
        steps: ["lint", "typecheck", "unit-tests", "integration-tests"],
      },
      {
        patterns: ["package.json", "package-lock.json"],
        steps: ["security-scan"],
      },
    ],
    defaultSteps: ["lint", "typecheck", "unit-tests"],
    timeoutSeconds: 1800,
  };
}
