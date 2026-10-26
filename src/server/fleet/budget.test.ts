/**
 * Tests for budget manager.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { BudgetManager, resetBudgetManager } from "./budget.js";

describe("BudgetManager", () => {
  let manager: BudgetManager;

  beforeEach(() => {
    resetBudgetManager();
    manager = new BudgetManager({
      enabled: true,
      maxDailyCost: 100,
      maxWeeklyCost: 500,
      providers: [],
    });
  });

  afterEach(() => {
    resetBudgetManager();
  });

  describe("provider budgets", () => {
    it("should add provider budget", () => {
      manager.setProviderBudget({
        provider: "claude",
        maxCostPerPeriod: 50,
        period: "daily",
        currentCost: 0,
        paused: false,
        periodStart: new Date().toISOString(),
      });

      const status = manager.getProviderStatus("claude");
      expect(status).toBeDefined();
      expect(status?.provider).toBe("claude");
      expect(status?.maxCostPerPeriod).toBe(50);
    });

    it("should track costs", () => {
      manager.setProviderBudget({
        provider: "claude",
        maxCostPerPeriod: 50,
        period: "daily",
        currentCost: 0,
        paused: false,
        periodStart: new Date().toISOString(),
      });

      manager.recordCost("claude", 10, "test job");
      manager.recordCost("claude", 15, "another job");

      const status = manager.getProviderStatus("claude");
      expect(status?.currentCost).toBe(25);
    });

    it("should pause provider when budget exceeded", () => {
      manager.setProviderBudget({
        provider: "claude",
        maxCostPerPeriod: 20,
        period: "daily",
        currentCost: 0,
        paused: false,
        periodStart: new Date().toISOString(),
      });

      manager.recordCost("claude", 25);

      const status = manager.getProviderStatus("claude");
      expect(status?.paused).toBe(true);
    });

    it("should check provider availability", () => {
      manager.setProviderBudget({
        provider: "claude",
        maxCostPerPeriod: 20,
        period: "daily",
        currentCost: 0,
        paused: false,
        periodStart: new Date().toISOString(),
      });

      expect(manager.isProviderAvailable("claude")).toBe(true);

      manager.recordCost("claude", 25);
      expect(manager.isProviderAvailable("claude")).toBe(false);
    });

    it("should allow manual unpause", () => {
      manager.setProviderBudget({
        provider: "claude",
        maxCostPerPeriod: 20,
        period: "daily",
        currentCost: 0,
        paused: false,
        periodStart: new Date().toISOString(),
      });

      manager.recordCost("claude", 25);
      expect(manager.isProviderAvailable("claude")).toBe(false);

      manager.unpauseProvider("claude");
      expect(manager.isProviderAvailable("claude")).toBe(true);
    });
  });

  describe("rate limiting", () => {
    it("should enforce rate limits", () => {
      manager.setProviderBudget({
        provider: "openai",
        maxCostPerPeriod: 100,
        period: "daily",
        currentCost: 0,
        paused: false,
        periodStart: new Date().toISOString(),
        rateLimit: 5, // 5 requests per minute
      });

      // Should allow first 5 requests
      for (let i = 0; i < 5; i++) {
        expect(manager.recordRequest("openai")).toBe(true);
      }

      // Should reject 6th request
      expect(manager.recordRequest("openai")).toBe(false);
    });
  });

  describe("overall status", () => {
    it("should report overall budget status", () => {
      manager.setProviderBudget({
        provider: "claude",
        maxCostPerPeriod: 50,
        period: "daily",
        currentCost: 0,
        paused: false,
        periodStart: new Date().toISOString(),
      });

      manager.recordCost("claude", 10);
      manager.recordCost("claude", 5);

      const status = manager.getStatus();
      expect(status.totalCostToday).toBe(15);
      expect(status.budgetRemaining).toBe(85); // 100 - 15
      expect(status.providers).toHaveLength(1);
    });

    it("should collect alerts", () => {
      manager.setProviderBudget({
        provider: "claude",
        maxCostPerPeriod: 10,
        period: "daily",
        currentCost: 0,
        paused: false,
        periodStart: new Date().toISOString(),
      });

      manager.recordCost("claude", 15); // Exceeds budget

      const status = manager.getStatus();
      expect(status.alerts.length).toBeGreaterThan(0);
      expect(status.alerts[0]).toContain("Budget exceeded");
    });
  });

  describe("config", () => {
    it("should update config", () => {
      manager.updateConfig({ maxDailyCost: 200 });
      const config = manager.getConfig();
      expect(config.maxDailyCost).toBe(200);
    });

    it("should return unknown provider as available when budgets disabled", () => {
      manager.updateConfig({ enabled: false });
      expect(manager.isProviderAvailable("unknown-provider")).toBe(true);
    });
  });
});
