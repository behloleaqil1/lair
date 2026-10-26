/**
 * Module registry tests
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  getModuleRegistry,
  resetModuleRegistry,
  registerModule,
  type ModuleRegistration,
  type Detector,
  type Playbook,
  type ViewRegistration,
} from "./modules.js";
import { EventBus } from "./core/event-bus.js";
import type { FastifyInstance } from "fastify";

describe("ModuleRegistry", () => {
  beforeEach(() => {
    resetModuleRegistry();
  });

  describe("register", () => {
    it("registers a module", () => {
      const module: ModuleRegistration = {
        id: "test",
        name: "Test Module",
        description: "A test module",
        dependencies: [],
      };

      registerModule(module);

      const registry = getModuleRegistry();
      expect(registry.get("test")).toEqual(module);
    });

    it("throws on duplicate registration", () => {
      const module: ModuleRegistration = {
        id: "test",
        name: "Test Module",
        description: "A test module",
        dependencies: [],
      };

      registerModule(module);
      expect(() => registerModule(module)).toThrow("already registered");
    });
  });

  describe("getAll", () => {
    it("returns all registered modules", () => {
      const mod1: ModuleRegistration = {
        id: "mod1",
        name: "Module 1",
        description: "",
        dependencies: [],
      };
      const mod2: ModuleRegistration = {
        id: "mod2",
        name: "Module 2",
        description: "",
        dependencies: [],
      };

      registerModule(mod1);
      registerModule(mod2);

      const registry = getModuleRegistry();
      const all = registry.getAll();
      expect(all).toHaveLength(2);
      expect(all.map((m) => m.id)).toContain("mod1");
      expect(all.map((m) => m.id)).toContain("mod2");
    });
  });

  describe("getAllDetectors", () => {
    it("collects detectors from all modules", () => {
      const detector1: Detector = {
        id: "detector1",
        name: "Detector 1",
        description: "",
        enabledByDefault: true,
        start: () => () => {},
      };
      const detector2: Detector = {
        id: "detector2",
        name: "Detector 2",
        description: "",
        enabledByDefault: false,
        start: () => () => {},
      };

      registerModule({
        id: "mod1",
        name: "Module 1",
        description: "",
        dependencies: [],
        detectors: [detector1],
      });
      registerModule({
        id: "mod2",
        name: "Module 2",
        description: "",
        dependencies: [],
        detectors: [detector2],
      });

      const registry = getModuleRegistry();
      const detectors = registry.getAllDetectors();
      expect(detectors).toHaveLength(2);
      expect(detectors.map((d) => d.id)).toContain("detector1");
      expect(detectors.map((d) => d.id)).toContain("detector2");
    });
  });

  describe("getAllPlaybooks", () => {
    it("collects playbooks from all modules", () => {
      const playbook1: Playbook = {
        id: "playbook1",
        name: "Playbook 1",
        description: "",
        forPatterns: ["pattern1"],
        requiresApproval: false,
        maxAttempts: 3,
        cooldownSeconds: 60,
      };

      registerModule({
        id: "mod1",
        name: "Module 1",
        description: "",
        dependencies: [],
        playbooks: [playbook1],
      });

      const registry = getModuleRegistry();
      const playbooks = registry.getAllPlaybooks();
      expect(playbooks).toHaveLength(1);
      expect(playbooks[0].id).toBe("playbook1");
    });
  });

  describe("getAllViews", () => {
    it("returns views sorted by order", () => {
      const view1: ViewRegistration = {
        id: "view1",
        name: "View 1",
        icon: "icon1",
        order: 20,
        showByDefault: true,
      };
      const view2: ViewRegistration = {
        id: "view2",
        name: "View 2",
        icon: "icon2",
        order: 10,
        showByDefault: true,
      };

      registerModule({
        id: "mod1",
        name: "Module 1",
        description: "",
        dependencies: [],
        views: [view1],
      });
      registerModule({
        id: "mod2",
        name: "Module 2",
        description: "",
        dependencies: [],
        views: [view2],
      });

      const registry = getModuleRegistry();
      const views = registry.getAllViews();
      expect(views).toHaveLength(2);
      expect(views[0].id).toBe("view2"); // order 10
      expect(views[1].id).toBe("view1"); // order 20
    });
  });

  describe("initialize", () => {
    it("initializes modules in dependency order", async () => {
      const order: string[] = [];

      registerModule({
        id: "base",
        name: "Base",
        description: "",
        dependencies: [],
        initialize: () => {
          order.push("base");
        },
      });
      registerModule({
        id: "dependent",
        name: "Dependent",
        description: "",
        dependencies: ["base"],
        initialize: () => {
          order.push("dependent");
        },
      });

      const registry = getModuleRegistry();
      const mockApp = {} as FastifyInstance;
      const eventBus = new EventBus();

      await registry.initialize(mockApp, eventBus);

      expect(order).toEqual(["base", "dependent"]);
    });

    it("throws on circular dependencies", async () => {
      registerModule({
        id: "a",
        name: "A",
        description: "",
        dependencies: ["b"],
      });
      registerModule({
        id: "b",
        name: "B",
        description: "",
        dependencies: ["a"],
      });

      const registry = getModuleRegistry();
      const mockApp = {} as FastifyInstance;
      const eventBus = new EventBus();

      await expect(registry.initialize(mockApp, eventBus)).rejects.toThrow(
        "Circular dependency"
      );
    });

    it("throws on unknown dependency", async () => {
      registerModule({
        id: "a",
        name: "A",
        description: "",
        dependencies: ["unknown"],
      });

      const registry = getModuleRegistry();
      const mockApp = {} as FastifyInstance;
      const eventBus = new EventBus();

      await expect(registry.initialize(mockApp, eventBus)).rejects.toThrow(
        "Unknown dependency 'unknown'"
      );
    });

    it("starts enabled detectors", async () => {
      const cleanup = vi.fn();
      const start = vi.fn().mockReturnValue(cleanup);

      const detector: Detector = {
        id: "test-detector",
        name: "Test Detector",
        description: "",
        enabledByDefault: true,
        start,
      };

      registerModule({
        id: "mod1",
        name: "Module 1",
        description: "",
        dependencies: [],
        detectors: [detector],
      });

      const registry = getModuleRegistry();
      const mockApp = {} as FastifyInstance;
      const eventBus = new EventBus();

      await registry.initialize(mockApp, eventBus);

      expect(start).toHaveBeenCalledWith(eventBus);
    });

    it("does not start disabled detectors", async () => {
      const start = vi.fn();

      const detector: Detector = {
        id: "test-detector",
        name: "Test Detector",
        description: "",
        enabledByDefault: false,
        start,
      };

      registerModule({
        id: "mod1",
        name: "Module 1",
        description: "",
        dependencies: [],
        detectors: [detector],
      });

      const registry = getModuleRegistry();
      const mockApp = {} as FastifyInstance;
      const eventBus = new EventBus();

      await registry.initialize(mockApp, eventBus);

      expect(start).not.toHaveBeenCalled();
    });

    it("registers routes", async () => {
      const registerRoutes = vi.fn();

      registerModule({
        id: "mod1",
        name: "Module 1",
        description: "",
        dependencies: [],
        registerRoutes,
      });

      const registry = getModuleRegistry();
      const mockApp = {} as FastifyInstance;
      const eventBus = new EventBus();

      await registry.initialize(mockApp, eventBus);

      expect(registerRoutes).toHaveBeenCalledWith(mockApp);
    });
  });

  describe("cleanup", () => {
    it("calls cleanup functions in reverse order", async () => {
      const order: string[] = [];

      registerModule({
        id: "mod1",
        name: "Module 1",
        description: "",
        dependencies: [],
        initialize: () => {
          order.push("init1");
        },
        cleanup: () => {
          order.push("cleanup1");
        },
      });
      registerModule({
        id: "mod2",
        name: "Module 2",
        description: "",
        dependencies: ["mod1"],
        initialize: () => {
          order.push("init2");
        },
        cleanup: () => {
          order.push("cleanup2");
        },
      });

      const registry = getModuleRegistry();
      const mockApp = {} as FastifyInstance;
      const eventBus = new EventBus();

      await registry.initialize(mockApp, eventBus);
      await registry.cleanup();

      // Init order: mod1, mod2
      // Cleanup order: mod2, mod1 (reverse)
      expect(order).toEqual(["init1", "init2", "cleanup2", "cleanup1"]);
    });

    it("continues cleanup even if one fails", async () => {
      const cleanup1 = vi.fn();
      const cleanup2 = vi.fn().mockRejectedValue(new Error("fail"));

      registerModule({
        id: "mod1",
        name: "Module 1",
        description: "",
        dependencies: [],
        cleanup: cleanup1,
      });
      registerModule({
        id: "mod2",
        name: "Module 2",
        description: "",
        dependencies: ["mod1"],
        cleanup: cleanup2,
      });

      const registry = getModuleRegistry();
      const mockApp = {} as FastifyInstance;
      const eventBus = new EventBus();

      await registry.initialize(mockApp, eventBus);
      await registry.cleanup();

      // Both cleanups should be called even if one fails
      expect(cleanup2).toHaveBeenCalled();
      expect(cleanup1).toHaveBeenCalled();
    });
  });
});
