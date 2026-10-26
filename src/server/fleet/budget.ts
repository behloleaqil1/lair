/**
 * Budget manager for fleet cost control.
 * Tracks provider costs, enforces rate limits, and pauses when exceeded.
 */
import type {
  BudgetConfig,
  BudgetStatus,
  ProviderBudget,
  BudgetPeriod,
} from "../../shared/fleet-types.js";

const DEFAULT_CONFIG: BudgetConfig = {
  enabled: false,
  maxDailyCost: 100,
  maxWeeklyCost: 500,
  maxMonthlyCost: 2000,
  costPerAgentHour: 0.5,
  providers: [],
};

/** Cost record for tracking */
interface CostRecord {
  timestamp: string;
  provider: string;
  cost: number;
  reason?: string;
}

/**
 * Budget manager.
 */
export class BudgetManager {
  private config: BudgetConfig;
  private costHistory: CostRecord[] = [];
  private rateLimitWindows = new Map<string, number[]>(); // provider -> timestamps of recent requests
  private alerts: string[] = [];

  constructor(config?: Partial<BudgetConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.initializeProviders();
  }

  /**
   * Initialize provider budgets with defaults.
   */
  private initializeProviders(): void {
    // Set period start to beginning of current period
    for (const provider of this.config.providers) {
      if (!provider.periodStart) {
        provider.periodStart = this.getPeriodStart(provider.period).toISOString();
      }
      if (provider.currentCost === undefined) {
        provider.currentCost = 0;
      }
      if (provider.paused === undefined) {
        provider.paused = false;
      }
    }
  }

  /**
   * Record a cost event.
   */
  recordCost(provider: string, cost: number, reason?: string): void {
    const now = new Date().toISOString();

    // Add to history
    this.costHistory.push({
      timestamp: now,
      provider,
      cost,
      reason,
    });

    // Keep only last 1000 records
    if (this.costHistory.length > 1000) {
      this.costHistory.shift();
    }

    // Update provider budget
    const budget = this.config.providers.find((p) => p.provider === provider);
    if (budget) {
      // Check if we need to reset the period
      this.maybeResetPeriod(budget);

      budget.currentCost += cost;

      // Check if budget exceeded
      if (budget.currentCost >= budget.maxCostPerPeriod) {
        budget.paused = true;
        this.addAlert(`Budget exceeded for ${provider}: $${budget.currentCost.toFixed(2)} / $${budget.maxCostPerPeriod.toFixed(2)}`);
        console.log(`[BudgetManager] Provider ${provider} paused: budget exceeded`);
      }
    }

    // Check global budgets
    this.checkGlobalBudgets();
  }

  /**
   * Record a request for rate limiting.
   */
  recordRequest(provider: string): boolean {
    const budget = this.config.providers.find((p) => p.provider === provider);
    if (!budget || !budget.rateLimit) {
      return true; // No rate limit
    }

    const now = Date.now();
    const oneMinuteAgo = now - 60000;

    // Get or create window
    let window = this.rateLimitWindows.get(provider);
    if (!window) {
      window = [];
      this.rateLimitWindows.set(provider, window);
    }

    // Remove old timestamps
    window = window.filter((ts) => ts > oneMinuteAgo);
    this.rateLimitWindows.set(provider, window);

    // Check rate limit
    if (window.length >= budget.rateLimit) {
      this.addAlert(`Rate limit exceeded for ${provider}: ${window.length}/${budget.rateLimit} requests/minute`);
      return false;
    }

    // Record request
    window.push(now);
    budget.currentRate = window.length;

    return true;
  }

  /**
   * Check if a provider is available (not paused or rate limited).
   */
  isProviderAvailable(provider: string): boolean {
    if (!this.config.enabled) {
      return true;
    }

    const budget = this.config.providers.find((p) => p.provider === provider);
    if (!budget) {
      return true; // No budget configured = unlimited
    }

    // Check if paused
    if (budget.paused) {
      return false;
    }

    // Check rate limit
    if (budget.rateLimit) {
      const window = this.rateLimitWindows.get(provider) ?? [];
      const now = Date.now();
      const oneMinuteAgo = now - 60000;
      const recentRequests = window.filter((ts) => ts > oneMinuteAgo).length;

      if (recentRequests >= budget.rateLimit) {
        return false;
      }
    }

    return true;
  }

  /**
   * Get budget status for a provider.
   */
  getProviderStatus(provider: string): ProviderBudget | undefined {
    const budget = this.config.providers.find((p) => p.provider === provider);
    if (budget) {
      this.maybeResetPeriod(budget);
      return { ...budget };
    }
    return undefined;
  }

  /**
   * Get overall budget status.
   */
  getStatus(): BudgetStatus {
    // Reset periods if needed
    for (const budget of this.config.providers) {
      this.maybeResetPeriod(budget);
    }

    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekStart = new Date(todayStart);
    weekStart.setDate(weekStart.getDate() - weekStart.getDay());
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    // Calculate totals
    const totalCostToday = this.calculateCostSince(todayStart);
    const totalCostThisWeek = this.calculateCostSince(weekStart);
    const totalCostThisMonth = this.calculateCostSince(monthStart);

    // Calculate remaining budget
    const budgetRemaining = Math.max(
      0,
      this.config.maxDailyCost - totalCostToday
    );

    return {
      totalCostToday,
      totalCostThisWeek,
      totalCostThisMonth,
      budgetRemaining,
      providers: this.config.providers.map((p) => ({ ...p })),
      alerts: [...this.alerts].slice(-10),
    };
  }

  /**
   * Add or update a provider budget.
   */
  setProviderBudget(budget: ProviderBudget): void {
    const existing = this.config.providers.findIndex((p) => p.provider === budget.provider);
    if (existing >= 0) {
      this.config.providers[existing] = { ...budget };
    } else {
      budget.periodStart = budget.periodStart ?? this.getPeriodStart(budget.period).toISOString();
      budget.currentCost = budget.currentCost ?? 0;
      budget.paused = budget.paused ?? false;
      this.config.providers.push(budget);
    }
  }

  /**
   * Remove a provider budget.
   */
  removeProviderBudget(provider: string): void {
    this.config.providers = this.config.providers.filter((p) => p.provider !== provider);
    this.rateLimitWindows.delete(provider);
  }

  /**
   * Unpause a provider (manual override).
   */
  unpauseProvider(provider: string): boolean {
    const budget = this.config.providers.find((p) => p.provider === provider);
    if (budget) {
      budget.paused = false;
      this.addAlert(`Provider ${provider} manually unpaused`);
      return true;
    }
    return false;
  }

  /**
   * Get current config.
   */
  getConfig(): BudgetConfig {
    return { ...this.config, providers: this.config.providers.map((p) => ({ ...p })) };
  }

  /**
   * Update config.
   */
  updateConfig(updates: Partial<BudgetConfig>): void {
    this.config = { ...this.config, ...updates };
    if (updates.providers) {
      this.initializeProviders();
    }
  }

  /**
   * Calculate cost since a given date.
   */
  private calculateCostSince(since: Date): number {
    const sinceTime = since.getTime();
    return this.costHistory
      .filter((r) => new Date(r.timestamp).getTime() >= sinceTime)
      .reduce((sum, r) => sum + r.cost, 0);
  }

  /**
   * Get the start of a budget period.
   */
  private getPeriodStart(period: BudgetPeriod): Date {
    const now = new Date();
    switch (period) {
      case "hourly":
        return new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours());
      case "daily":
        return new Date(now.getFullYear(), now.getMonth(), now.getDate());
      case "weekly": {
        const day = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        day.setDate(day.getDate() - day.getDay());
        return day;
      }
      case "monthly":
        return new Date(now.getFullYear(), now.getMonth(), 1);
      default:
        return now;
    }
  }

  /**
   * Check if a period has passed and reset if needed.
   */
  private maybeResetPeriod(budget: ProviderBudget): void {
    const periodStart = new Date(budget.periodStart);
    const now = new Date();

    let shouldReset = false;
    switch (budget.period) {
      case "hourly":
        shouldReset = now.getTime() - periodStart.getTime() >= 3600000;
        break;
      case "daily":
        shouldReset = now.getDate() !== periodStart.getDate() || now.getMonth() !== periodStart.getMonth();
        break;
      case "weekly":
        shouldReset = now.getTime() - periodStart.getTime() >= 7 * 86400000;
        break;
      case "monthly":
        shouldReset = now.getMonth() !== periodStart.getMonth() || now.getFullYear() !== periodStart.getFullYear();
        break;
    }

    if (shouldReset) {
      budget.periodStart = this.getPeriodStart(budget.period).toISOString();
      budget.currentCost = 0;
      budget.paused = false;
      console.log(`[BudgetManager] Reset period for ${budget.provider}`);
    }
  }

  /**
   * Check global budget limits.
   */
  private checkGlobalBudgets(): void {
    const status = this.getStatus();

    if (status.totalCostToday >= this.config.maxDailyCost) {
      this.addAlert(`Daily budget exceeded: $${status.totalCostToday.toFixed(2)} / $${this.config.maxDailyCost.toFixed(2)}`);
      // Pause all providers
      for (const provider of this.config.providers) {
        provider.paused = true;
      }
    }

    if (this.config.maxWeeklyCost && status.totalCostThisWeek >= this.config.maxWeeklyCost) {
      this.addAlert(`Weekly budget exceeded: $${status.totalCostThisWeek.toFixed(2)} / $${this.config.maxWeeklyCost.toFixed(2)}`);
    }

    if (this.config.maxMonthlyCost && status.totalCostThisMonth >= this.config.maxMonthlyCost) {
      this.addAlert(`Monthly budget exceeded: $${status.totalCostThisMonth.toFixed(2)} / $${this.config.maxMonthlyCost.toFixed(2)}`);
    }
  }

  /**
   * Add an alert.
   */
  private addAlert(message: string): void {
    const timestamped = `${new Date().toISOString()}: ${message}`;
    this.alerts.push(timestamped);

    // Keep only last 50 alerts
    if (this.alerts.length > 50) {
      this.alerts.shift();
    }

    console.log(`[BudgetManager] Alert: ${message}`);
  }
}

// Global singleton
let globalBudgetManager: BudgetManager | null = null;

/**
 * Get or create the global budget manager.
 */
export function getBudgetManager(config?: Partial<BudgetConfig>): BudgetManager {
  if (!globalBudgetManager) {
    globalBudgetManager = new BudgetManager(config);
  }
  return globalBudgetManager;
}

/**
 * Reset the budget manager.
 */
export function resetBudgetManager(): void {
  globalBudgetManager = null;
}
