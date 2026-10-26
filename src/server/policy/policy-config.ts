/**
 * Policy configuration loader.
 * Parses and validates policy configs.
 */
import { z } from "zod";
import type {
  PolicyConfig,
  RiskTierRule,
  ReviewRequirement,
  ProtectedTestRule,
  MergeWindow,
  RiskTier,
} from "../../shared/policy-types.js";

// ============ SCHEMAS ============

const RiskTierSchema = z.enum(["red", "amber", "green"]);

const RiskTierRuleSchema = z.object({
  patterns: z.array(z.string().min(1)).min(1),
  tier: RiskTierSchema,
  description: z.string().optional(),
});

const ReviewRequirementSchema = z.object({
  count: z.number().int().positive(),
  distinctAgents: z.boolean(),
  distinctModels: z.boolean().optional(),
  humanRequired: z.boolean().optional(),
});

const ProtectedTestRuleSchema = z.object({
  patterns: z.array(z.string().min(1)).min(1),
  weakeningPatterns: z.array(z.string().min(1)),
  description: z.string().optional(),
});

const MergeWindowSchema = z.object({
  daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1),
  startHour: z.number().int().min(0).max(23),
  endHour: z.number().int().min(0).max(23),
});

const PolicyConfigSchema = z.object({
  projectId: z.string().min(1),
  riskTiers: z.array(RiskTierRuleSchema),
  reviewRequirements: z.object({
    red: ReviewRequirementSchema.optional(),
    amber: ReviewRequirementSchema.optional(),
    green: ReviewRequirementSchema.optional(),
  }),
  requiredGates: z.array(z.string()).min(1),
  protectedTests: z.array(ProtectedTestRuleSchema).default([]),
  maxPrSize: z.number().int().positive().optional(),
  mergeWindows: z.array(MergeWindowSchema).optional(),
  blockedPatterns: z.array(z.string()).optional(),
});

// ============ PARSING ============

/**
 * Parse and validate a policy config.
 */
export function parsePolicyConfig(input: unknown): PolicyConfig {
  return PolicyConfigSchema.parse(input) as PolicyConfig;
}

// ============ RISK TIER COMPUTATION ============

/**
 * Match a file path against a glob pattern.
 */
function matchGlob(pattern: string, path: string): boolean {
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
 * Compute the risk tier for a set of changed files.
 * Returns the highest tier that matches any file.
 */
export function computeRiskTier(
  changedFiles: string[],
  rules: RiskTierRule[]
): RiskTier {
  const tierPriority: Record<RiskTier, number> = {
    red: 3,
    amber: 2,
    green: 1,
  };

  let highestTier: RiskTier = "green";
  let highestPriority = 1;

  for (const rule of rules) {
    const matches = changedFiles.some(file =>
      rule.patterns.some(pattern => matchGlob(pattern, file))
    );

    if (matches) {
      const priority = tierPriority[rule.tier];
      if (priority > highestPriority) {
        highestTier = rule.tier;
        highestPriority = priority;
      }
    }
  }

  return highestTier;
}

/**
 * Get the review requirement for a tier.
 */
export function getReviewRequirement(
  policy: PolicyConfig,
  tier: RiskTier
): ReviewRequirement | undefined {
  return policy.reviewRequirements[tier];
}

// ============ MERGE WINDOW CHECK ============

/**
 * Check if the current time is within a merge window.
 */
export function isWithinMergeWindow(
  windows: MergeWindow[] | undefined,
  now: Date = new Date()
): boolean {
  // If no windows defined, always allowed
  if (!windows || windows.length === 0) {
    return true;
  }

  const dayOfWeek = now.getUTCDay();
  const hour = now.getUTCHours();

  return windows.some(window => {
    // Check day of week
    if (!window.daysOfWeek.includes(dayOfWeek)) {
      return false;
    }

    // Check hour (handles windows that cross midnight)
    if (window.startHour <= window.endHour) {
      // Normal window (e.g., 9-17)
      return hour >= window.startHour && hour < window.endHour;
    } else {
      // Window crosses midnight (e.g., 22-06)
      return hour >= window.startHour || hour < window.endHour;
    }
  });
}

// ============ PROTECTED TEST CHECK ============

/**
 * Check if a diff weakens protected tests.
 */
export function checkProtectedTests(
  policy: PolicyConfig,
  changedFiles: string[],
  diffContent: string
): { violations: string[]; matchedRules: ProtectedTestRule[] } {
  const violations: string[] = [];
  const matchedRules: ProtectedTestRule[] = [];

  for (const rule of policy.protectedTests) {
    // Check if any protected test files are changed
    const protectedFilesChanged = changedFiles.filter(file =>
      rule.patterns.some(pattern => matchGlob(pattern, file))
    );

    if (protectedFilesChanged.length === 0) {
      continue;
    }

    matchedRules.push(rule);

    // Check for weakening patterns in the diff
    for (const weakenPattern of rule.weakeningPatterns) {
      try {
        const regex = new RegExp(weakenPattern, "gm");
        const matches = diffContent.match(regex);
        if (matches && matches.length > 0) {
          violations.push(
            `Protected test weakening detected: "${weakenPattern}" found in ${protectedFilesChanged.join(", ")}${rule.description ? ` (${rule.description})` : ""}`
          );
        }
      } catch {
        // Invalid regex, skip
      }
    }
  }

  return { violations, matchedRules };
}

// ============ BLOCKED PATTERNS CHECK ============

/**
 * Check if any changed files match blocked patterns.
 */
export function checkBlockedPatterns(
  patterns: string[] | undefined,
  changedFiles: string[]
): string[] {
  if (!patterns || patterns.length === 0) {
    return [];
  }

  const blockedFiles: string[] = [];

  for (const file of changedFiles) {
    for (const pattern of patterns) {
      if (matchGlob(pattern, file)) {
        blockedFiles.push(file);
        break;
      }
    }
  }

  return blockedFiles;
}

// ============ EXAMPLE POLICY ============

/**
 * Create an example policy for documentation/testing.
 */
export function createExamplePolicy(): PolicyConfig {
  return {
    projectId: "example-project",
    riskTiers: [
      {
        patterns: ["**/auth/**", "**/security/**", "**/billing/**", "**/migrations/**"],
        tier: "red",
        description: "Security, auth, billing, and migrations require extra scrutiny",
      },
      {
        patterns: ["**/api/**", "**/db/**", "**/config/**"],
        tier: "amber",
        description: "API, database, and config changes need peer review",
      },
      {
        patterns: ["**/*.ts", "**/*.tsx"],
        tier: "green",
        description: "Default tier for code changes",
      },
    ],
    reviewRequirements: {
      red: {
        count: 2,
        distinctAgents: true,
        distinctModels: true,
        humanRequired: true,
      },
      amber: {
        count: 1,
        distinctAgents: true,
      },
      green: {
        count: 0,
        distinctAgents: false,
      },
    },
    requiredGates: ["example-backend"],
    protectedTests: [
      {
        patterns: ["**/*.test.ts", "**/*.spec.ts"],
        weakeningPatterns: [
          "\\.(skip|only)\\(",
          "@(Disabled|Ignore)",
          "eslint-disable",
          "ts-ignore",
          "nosemgrep",
        ],
        description: "Test suppressions are not allowed",
      },
    ],
    maxPrSize: 1000,
    mergeWindows: [
      {
        daysOfWeek: [1, 2, 3, 4, 5], // Monday-Friday
        startHour: 9,
        endHour: 17,
      },
    ],
    blockedPatterns: [
      "**/.env",
      "**/secrets/**",
      "**/credentials/**",
    ],
  };
}
