/**
 * Lair Module Registry
 *
 * Central registry for server modules. Each module registers itself here
 * so that the server can initialize routes, events, detectors, playbooks
 * and views without coupling modules to each other.
 *
 * Per SPEC-autonomy §0.5: modules talk ONLY through the event bus and store.
 * New event names go in src/shared/events.ts (append only).
 */

import type { FastifyInstance } from "fastify";
import type { EventBus } from "./core/event-bus.js";

/**
 * A detector that watches for SLO breaches or failures
 */
export interface Detector {
  /** Unique detector ID */
  id: string;
  /** Human-readable name */
  name: string;
  /** What this detector monitors */
  description: string;
  /** Whether this detector is enabled by default */
  enabledByDefault: boolean;
  /**
   * Start the detector. Called when the server starts.
   * The detector should subscribe to events or start intervals.
   * Returns a cleanup function.
   */
  start: (eventBus: EventBus) => () => void;
}

/**
 * A recovery playbook that can fix a detected problem
 */
export interface Playbook {
  /** Unique playbook ID */
  id: string;
  /** Human-readable name */
  name: string;
  /** What this playbook does */
  description: string;
  /** Which detector patterns this playbook handles */
  forPatterns: string[];
  /** Whether owner approval is required before running */
  requiresApproval: boolean;
  /** Maximum number of retry attempts */
  maxAttempts: number;
  /** Cooldown between attempts in seconds */
  cooldownSeconds: number;
}

/**
 * A client-side view component
 */
export interface ViewRegistration {
  /** Unique view ID (used in routing) */
  id: string;
  /** Display name in navigation */
  name: string;
  /** Icon name (from lucide-react) */
  icon: string;
  /** Order in navigation (lower = higher) */
  order: number;
  /** Whether this view is shown by default */
  showByDefault: boolean;
}

/**
 * Module registration information
 */
export interface ModuleRegistration {
  /** Module ID (matches directory name under src/server/) */
  id: string;
  /** Human-readable name */
  name: string;
  /** Module description */
  description: string;
  /** Dependencies on other modules (IDs) */
  dependencies: string[];

  /** Route registration function */
  registerRoutes?: (app: FastifyInstance) => Promise<void> | void;

  /** Event types this module emits */
  emitsEvents?: string[];

  /** Event types this module subscribes to */
  subscribesToEvents?: string[];

  /** Detectors provided by this module */
  detectors?: Detector[];

  /** Playbooks provided by this module */
  playbooks?: Playbook[];

  /** Views provided by this module */
  views?: ViewRegistration[];

  /**
   * Module initialization function.
   * Called after all modules are registered, in dependency order.
   */
  initialize?: (eventBus: EventBus) => Promise<void> | void;

  /**
   * Module cleanup function.
   * Called when the server shuts down.
   */
  cleanup?: () => Promise<void> | void;
}

/**
 * The module registry singleton
 */
class ModuleRegistry {
  private modules = new Map<string, ModuleRegistration>();
  private initialized = false;
  private cleanupFunctions: Array<() => Promise<void> | void> = [];

  /**
   * Register a module
   */
  register(module: ModuleRegistration): void {
    if (this.initialized) {
      throw new Error(
        `Cannot register module '${module.id}' after initialization. ` +
        `Register all modules before calling initialize().`
      );
    }

    if (this.modules.has(module.id)) {
      throw new Error(`Module '${module.id}' is already registered`);
    }

    this.modules.set(module.id, module);
    console.log(`[modules] Registered: ${module.id}`);
  }

  /**
   * Get a registered module by ID
   */
  get(id: string): ModuleRegistration | undefined {
    return this.modules.get(id);
  }

  /**
   * Get all registered modules
   */
  getAll(): ModuleRegistration[] {
    return Array.from(this.modules.values());
  }

  /**
   * Get all detectors from all modules
   */
  getAllDetectors(): Detector[] {
    const detectors: Detector[] = [];
    for (const module of this.modules.values()) {
      if (module.detectors) {
        detectors.push(...module.detectors);
      }
    }
    return detectors;
  }

  /**
   * Get all playbooks from all modules
   */
  getAllPlaybooks(): Playbook[] {
    const playbooks: Playbook[] = [];
    for (const module of this.modules.values()) {
      if (module.playbooks) {
        playbooks.push(...module.playbooks);
      }
    }
    return playbooks;
  }

  /**
   * Get all views from all modules, sorted by order
   */
  getAllViews(): ViewRegistration[] {
    const views: ViewRegistration[] = [];
    for (const module of this.modules.values()) {
      if (module.views) {
        views.push(...module.views);
      }
    }
    return views.sort((a, b) => a.order - b.order);
  }

  /**
   * Get modules in dependency order (topological sort)
   */
  private getInitializationOrder(): ModuleRegistration[] {
    const result: ModuleRegistration[] = [];
    const visited = new Set<string>();
    const visiting = new Set<string>();

    const visit = (id: string): void => {
      if (visited.has(id)) return;
      if (visiting.has(id)) {
        throw new Error(`Circular dependency detected involving module '${id}'`);
      }

      const module = this.modules.get(id);
      if (!module) {
        throw new Error(`Unknown dependency '${id}'`);
      }

      visiting.add(id);

      for (const depId of module.dependencies) {
        visit(depId);
      }

      visiting.delete(id);
      visited.add(id);
      result.push(module);
    };

    for (const id of this.modules.keys()) {
      visit(id);
    }

    return result;
  }

  /**
   * Initialize all modules in dependency order
   */
  async initialize(app: FastifyInstance, eventBus: EventBus): Promise<void> {
    if (this.initialized) {
      throw new Error("Module registry already initialized");
    }

    const modules = this.getInitializationOrder();
    console.log(
      `[modules] Initializing ${modules.length} modules: ` +
      modules.map(m => m.id).join(", ")
    );

    // Register routes
    for (const module of modules) {
      if (module.registerRoutes) {
        await module.registerRoutes(app);
        console.log(`[modules] Routes registered: ${module.id}`);
      }
    }

    // Initialize modules
    for (const module of modules) {
      if (module.initialize) {
        await module.initialize(eventBus);
        console.log(`[modules] Initialized: ${module.id}`);
      }

      // Start detectors
      if (module.detectors) {
        for (const detector of module.detectors) {
          if (detector.enabledByDefault) {
            const cleanup = detector.start(eventBus);
            this.cleanupFunctions.push(cleanup);
            console.log(`[modules] Detector started: ${detector.id}`);
          }
        }
      }

      // Track cleanup
      if (module.cleanup) {
        this.cleanupFunctions.push(module.cleanup);
      }
    }

    this.initialized = true;
    console.log("[modules] All modules initialized");
  }

  /**
   * Cleanup all modules
   */
  async cleanup(): Promise<void> {
    console.log("[modules] Cleaning up modules...");

    for (const fn of this.cleanupFunctions.reverse()) {
      try {
        await fn();
      } catch (error) {
        console.error("[modules] Cleanup error:", error);
      }
    }

    this.cleanupFunctions = [];
    this.initialized = false;
    console.log("[modules] Cleanup complete");
  }

  /**
   * Reset the registry (for testing)
   */
  reset(): void {
    this.modules.clear();
    this.cleanupFunctions = [];
    this.initialized = false;
  }
}

// Singleton instance
let registry: ModuleRegistry | null = null;

/**
 * Get the module registry instance
 */
export function getModuleRegistry(): ModuleRegistry {
  if (!registry) {
    registry = new ModuleRegistry();
  }
  return registry;
}

/**
 * Reset the module registry (for testing)
 */
export function resetModuleRegistry(): void {
  if (registry) {
    registry.reset();
  }
  registry = null;
}

/**
 * Convenience function to register a module
 */
export function registerModule(module: ModuleRegistration): void {
  getModuleRegistry().register(module);
}
