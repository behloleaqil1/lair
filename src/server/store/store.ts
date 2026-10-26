/**
 * SQLite store for lair-server.
 * Handles nodes, tasks, jobs, events, and agent runs.
 */
import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { getCurrentVersion, getPendingMigrations } from "./migrations.js";
import type {
  Node,
  NodeCapacity,
  NodeStatus,
  Task,
  TaskStatus,
  TaskType,
  TaskPriority,
  Job,
  JobStatus,
  Event,
  EventType,
  AgentRun,
  AgentRunStatus,
  CreateTaskRequest,
} from "../../shared/server-types.js";

/**
 * Store configuration.
 */
export interface StoreConfig {
  /** Path to SQLite database file */
  dbPath: string;
  /** Enable WAL mode for better concurrent performance */
  walMode?: boolean;
}

/**
 * SQLite-based store for lair-server.
 */
export class Store {
  private db: Database.Database;

  constructor(config: StoreConfig) {
    // Ensure directory exists
    const dir = dirname(config.dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(config.dbPath);

    // Enable WAL mode for better concurrent performance
    if (config.walMode !== false) {
      this.db.pragma("journal_mode = WAL");
    }

    // Run migrations
    this.migrate();

    console.log(`[Store] Initialized at ${config.dbPath}`);
  }

  /**
   * Run pending migrations.
   */
  private migrate(): void {
    const currentVersion = getCurrentVersion(this.db);
    const pending = getPendingMigrations(currentVersion);

    if (pending.length === 0) {
      console.log(`[Store] Schema up to date (v${currentVersion})`);
      return;
    }

    console.log(`[Store] Applying ${pending.length} migration(s)...`);

    for (const migration of pending) {
      console.log(`[Store] Applying migration v${migration.version}: ${migration.name}`);
      this.db.exec(migration.up);
    }

    console.log(`[Store] Migrations complete (now v${pending[pending.length - 1].version})`);
  }

  // ============ NODES ============

  /**
   * Register a new node or update an existing one.
   */
  registerNode(
    id: string,
    name: string,
    capacity: NodeCapacity,
    extra?: { version?: string; os?: string; arch?: string }
  ): Node {
    const now = new Date().toISOString();

    const stmt = this.db.prepare(`
      INSERT INTO nodes (id, name, status, capacity_cores, capacity_ram_mb, capacity_disk_gb, 
                         capacity_gpu_count, container_runtime, registered_at, last_heartbeat,
                         version, os, arch)
      VALUES (?, ?, 'online', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        status = 'online',
        capacity_cores = excluded.capacity_cores,
        capacity_ram_mb = excluded.capacity_ram_mb,
        capacity_disk_gb = excluded.capacity_disk_gb,
        capacity_gpu_count = excluded.capacity_gpu_count,
        container_runtime = excluded.container_runtime,
        last_heartbeat = excluded.last_heartbeat,
        version = excluded.version,
        os = excluded.os,
        arch = excluded.arch
    `);

    stmt.run(
      id,
      name,
      capacity.cores,
      capacity.ramMb,
      capacity.diskGb,
      capacity.gpuCount,
      capacity.containerRuntime,
      now,
      now,
      extra?.version ?? null,
      extra?.os ?? null,
      extra?.arch ?? null
    );

    return this.getNode(id)!;
  }

  /**
   * Update node heartbeat and used capacity.
   */
  updateNodeHeartbeat(
    nodeId: string,
    usedCapacity: { cores: number; ramMb: number },
    activeJobs: number
  ): void {
    const stmt = this.db.prepare(`
      UPDATE nodes SET 
        last_heartbeat = ?,
        used_cores = ?,
        used_ram_mb = ?,
        active_jobs = ?,
        status = 'online'
      WHERE id = ?
    `);
    stmt.run(new Date().toISOString(), usedCapacity.cores, usedCapacity.ramMb, activeJobs, nodeId);
  }

  /**
   * Mark a node as offline.
   */
  markNodeOffline(nodeId: string): void {
    const stmt = this.db.prepare("UPDATE nodes SET status = 'offline' WHERE id = ?");
    stmt.run(nodeId);
  }

  /**
   * Mark a node as draining (no new jobs).
   */
  markNodeDraining(nodeId: string): void {
    const stmt = this.db.prepare("UPDATE nodes SET status = 'draining' WHERE id = ?");
    stmt.run(nodeId);
  }

  /**
   * Get a node by ID.
   */
  getNode(nodeId: string): Node | null {
    const row = this.db.prepare("SELECT * FROM nodes WHERE id = ?").get(nodeId) as NodeRow | undefined;
    return row ? this.rowToNode(row) : null;
  }

  /**
   * List all nodes.
   */
  listNodes(): Node[] {
    const rows = this.db.prepare("SELECT * FROM nodes ORDER BY name").all() as NodeRow[];
    return rows.map((row) => this.rowToNode(row));
  }

  /**
   * List online nodes with available capacity.
   */
  listAvailableNodes(): Node[] {
    const rows = this.db.prepare(`
      SELECT * FROM nodes 
      WHERE status = 'online' 
      AND (capacity_cores - used_cores) > 0
      AND (capacity_ram_mb - used_ram_mb) > 0
      ORDER BY (capacity_cores - used_cores) DESC
    `).all() as NodeRow[];
    return rows.map((row) => this.rowToNode(row));
  }

  // ============ TASKS ============

  /**
   * Create a new task.
   */
  createTask(request: CreateTaskRequest): Task {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    const stmt = this.db.prepare(`
      INSERT INTO tasks (id, type, priority, status, title, description, requirements, metadata, created_at, updated_at)
      VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      request.type,
      request.priority ?? 2,
      request.title,
      request.description ?? null,
      request.requirements ? JSON.stringify(request.requirements) : null,
      request.metadata ? JSON.stringify(request.metadata) : null,
      now,
      now
    );

    return this.getTask(id)!;
  }

  /**
   * Get a task by ID.
   */
  getTask(taskId: string): Task | null {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as TaskRow | undefined;
    return row ? this.rowToTask(row) : null;
  }

  /**
   * List tasks with optional filtering.
   */
  listTasks(options?: { status?: TaskStatus; limit?: number; offset?: number }): Task[] {
    let sql = "SELECT * FROM tasks";
    const params: unknown[] = [];

    if (options?.status) {
      sql += " WHERE status = ?";
      params.push(options.status);
    }

    sql += " ORDER BY priority DESC, created_at ASC";

    if (options?.limit) {
      sql += " LIMIT ?";
      params.push(options.limit);
      if (options.offset) {
        sql += " OFFSET ?";
        params.push(options.offset);
      }
    }

    const rows = this.db.prepare(sql).all(...params) as TaskRow[];
    return rows.map((row) => this.rowToTask(row));
  }

  /**
   * Get queued tasks ready for assignment.
   */
  getQueuedTasks(): Task[] {
    const rows = this.db.prepare(`
      SELECT * FROM tasks 
      WHERE status = 'queued'
      ORDER BY priority DESC, created_at ASC
    `).all() as TaskRow[];
    return rows.map((row) => this.rowToTask(row));
  }

  /**
   * Update task status.
   */
  updateTaskStatus(taskId: string, status: TaskStatus, extra?: Partial<Task>): void {
    const updates: string[] = ["status = ?", "updated_at = ?"];
    const params: unknown[] = [status, new Date().toISOString()];

    if (extra?.assignedNode !== undefined) {
      updates.push("assigned_node = ?");
      params.push(extra.assignedNode);
    }
    if (extra?.assignedAgent !== undefined) {
      updates.push("assigned_agent = ?");
      params.push(extra.assignedAgent);
    }
    if (extra?.jobId !== undefined) {
      updates.push("job_id = ?");
      params.push(extra.jobId);
    }
    if (extra?.startedAt !== undefined) {
      updates.push("started_at = ?");
      params.push(extra.startedAt);
    }
    if (extra?.completedAt !== undefined) {
      updates.push("completed_at = ?");
      params.push(extra.completedAt);
    }
    if (extra?.result !== undefined) {
      updates.push("result = ?");
      params.push(JSON.stringify(extra.result));
    }

    params.push(taskId);
    const stmt = this.db.prepare(`UPDATE tasks SET ${updates.join(", ")} WHERE id = ?`);
    stmt.run(...params);
  }

  /**
   * Count tasks by status.
   */
  countTasks(status?: TaskStatus): number {
    if (status) {
      const row = this.db.prepare("SELECT COUNT(*) as count FROM tasks WHERE status = ?").get(status) as { count: number };
      return row.count;
    }
    const row = this.db.prepare("SELECT COUNT(*) as count FROM tasks").get() as { count: number };
    return row.count;
  }

  // ============ JOBS ============

  /**
   * Create a new job for a task.
   */
  createJob(taskId: string, nodeId: string, allocatedCores: number, allocatedRamMb: number): Job {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    const stmt = this.db.prepare(`
      INSERT INTO jobs (id, task_id, node_id, status, allocated_cores, allocated_ram_mb, created_at)
      VALUES (?, ?, ?, 'pending', ?, ?, ?)
    `);
    stmt.run(id, taskId, nodeId, allocatedCores, allocatedRamMb, now);

    return this.getJob(id)!;
  }

  /**
   * Get a job by ID.
   */
  getJob(jobId: string): Job | null {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId) as JobRow | undefined;
    return row ? this.rowToJob(row) : null;
  }

  /**
   * List jobs with optional filtering.
   */
  listJobs(options?: { status?: JobStatus; nodeId?: string; limit?: number }): Job[] {
    let sql = "SELECT * FROM jobs";
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (options?.status) {
      conditions.push("status = ?");
      params.push(options.status);
    }
    if (options?.nodeId) {
      conditions.push("node_id = ?");
      params.push(options.nodeId);
    }

    if (conditions.length > 0) {
      sql += " WHERE " + conditions.join(" AND ");
    }

    sql += " ORDER BY created_at DESC";

    if (options?.limit) {
      sql += " LIMIT ?";
      params.push(options.limit);
    }

    const rows = this.db.prepare(sql).all(...params) as JobRow[];
    return rows.map((row) => this.rowToJob(row));
  }

  /**
   * Update job status.
   */
  updateJobStatus(
    jobId: string,
    status: JobStatus,
    extra?: { startedAt?: string; completedAt?: string; exitCode?: number; output?: string; error?: string; agentId?: string }
  ): void {
    const updates: string[] = ["status = ?"];
    const params: unknown[] = [status];

    if (extra?.startedAt !== undefined) {
      updates.push("started_at = ?");
      params.push(extra.startedAt);
    }
    if (extra?.completedAt !== undefined) {
      updates.push("completed_at = ?");
      params.push(extra.completedAt);
    }
    if (extra?.exitCode !== undefined) {
      updates.push("exit_code = ?");
      params.push(extra.exitCode);
    }
    if (extra?.output !== undefined) {
      updates.push("output = ?");
      params.push(extra.output);
    }
    if (extra?.error !== undefined) {
      updates.push("error = ?");
      params.push(extra.error);
    }
    if (extra?.agentId !== undefined) {
      updates.push("agent_id = ?");
      params.push(extra.agentId);
    }

    params.push(jobId);
    const stmt = this.db.prepare(`UPDATE jobs SET ${updates.join(", ")} WHERE id = ?`);
    stmt.run(...params);
  }

  /**
   * Count jobs by status.
   */
  countJobs(status?: JobStatus): number {
    if (status) {
      const row = this.db.prepare("SELECT COUNT(*) as count FROM jobs WHERE status = ?").get(status) as { count: number };
      return row.count;
    }
    const row = this.db.prepare("SELECT COUNT(*) as count FROM jobs").get() as { count: number };
    return row.count;
  }

  // ============ EVENTS ============

  /**
   * Store an event.
   */
  storeEvent(event: Event): void {
    const stmt = this.db.prepare(`
      INSERT INTO events (id, type, timestamp, data)
      VALUES (?, ?, ?, ?)
    `);
    stmt.run(event.id, event.type, event.timestamp, JSON.stringify(event.data));
  }

  /**
   * List recent events.
   */
  listEvents(options?: { type?: EventType; limit?: number; since?: string }): Event[] {
    let sql = "SELECT * FROM events";
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (options?.type) {
      conditions.push("type = ?");
      params.push(options.type);
    }
    if (options?.since) {
      conditions.push("timestamp > ?");
      params.push(options.since);
    }

    if (conditions.length > 0) {
      sql += " WHERE " + conditions.join(" AND ");
    }

    sql += " ORDER BY timestamp DESC";

    if (options?.limit) {
      sql += " LIMIT ?";
      params.push(options.limit);
    }

    const rows = this.db.prepare(sql).all(...params) as EventRow[];
    return rows.map((row) => ({
      id: row.id,
      type: row.type as EventType,
      timestamp: row.timestamp,
      data: JSON.parse(row.data),
    }));
  }

  // ============ AGENT RUNS ============

  /**
   * Create an agent run.
   */
  createAgentRun(nodeId: string, adapter: string, jobId?: string, taskId?: string): AgentRun {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    const stmt = this.db.prepare(`
      INSERT INTO agent_runs (id, node_id, job_id, task_id, adapter, status, started_at)
      VALUES (?, ?, ?, ?, ?, 'running', ?)
    `);
    stmt.run(id, nodeId, jobId ?? null, taskId ?? null, adapter, now);

    return this.getAgentRun(id)!;
  }

  /**
   * Get an agent run by ID.
   */
  getAgentRun(runId: string): AgentRun | null {
    const row = this.db.prepare("SELECT * FROM agent_runs WHERE id = ?").get(runId) as AgentRunRow | undefined;
    return row ? this.rowToAgentRun(row) : null;
  }

  /**
   * Update agent run status.
   */
  updateAgentRunStatus(
    runId: string,
    status: AgentRunStatus,
    extra?: { completedAt?: string; exitCode?: number; peakRamMb?: number; cpuSeconds?: number; output?: string }
  ): void {
    const updates: string[] = ["status = ?"];
    const params: unknown[] = [status];

    if (extra?.completedAt !== undefined) {
      updates.push("completed_at = ?");
      params.push(extra.completedAt);
    }
    if (extra?.exitCode !== undefined) {
      updates.push("exit_code = ?");
      params.push(extra.exitCode);
    }
    if (extra?.peakRamMb !== undefined) {
      updates.push("peak_ram_mb = ?");
      params.push(extra.peakRamMb);
    }
    if (extra?.cpuSeconds !== undefined) {
      updates.push("cpu_seconds = ?");
      params.push(extra.cpuSeconds);
    }
    if (extra?.output !== undefined) {
      updates.push("output = ?");
      params.push(extra.output);
    }

    params.push(runId);
    const stmt = this.db.prepare(`UPDATE agent_runs SET ${updates.join(", ")} WHERE id = ?`);
    stmt.run(...params);
  }

  /**
   * Count running agent runs.
   */
  countRunningAgents(): number {
    const row = this.db.prepare("SELECT COUNT(*) as count FROM agent_runs WHERE status = 'running'").get() as { count: number };
    return row.count;
  }

  // ============ UTILITIES ============

  /**
   * Close the database connection.
   */
  close(): void {
    this.db.close();
    console.log("[Store] Closed");
  }

  // Row type definitions
  private rowToNode(row: NodeRow): Node {
    return {
      id: row.id,
      name: row.name,
      status: row.status as NodeStatus,
      capacity: {
        cores: row.capacity_cores,
        ramMb: row.capacity_ram_mb,
        diskGb: row.capacity_disk_gb,
        gpuCount: row.capacity_gpu_count,
        containerRuntime: (row.container_runtime as NodeCapacity["containerRuntime"]) ?? "none",
      },
      usedCapacity: {
        cores: row.used_cores,
        ramMb: row.used_ram_mb,
      },
      activeJobs: row.active_jobs,
      lastHeartbeat: row.last_heartbeat ?? row.registered_at,
      registeredAt: row.registered_at,
      version: row.version ?? undefined,
      os: row.os ?? undefined,
      arch: row.arch ?? undefined,
    };
  }

  private rowToTask(row: TaskRow): Task {
    return {
      id: row.id,
      type: row.type as TaskType,
      priority: row.priority as TaskPriority,
      status: row.status as TaskStatus,
      title: row.title,
      description: row.description ?? undefined,
      assignedNode: row.assigned_node ?? undefined,
      assignedAgent: row.assigned_agent ?? undefined,
      jobId: row.job_id ?? undefined,
      requirements: row.requirements ? JSON.parse(row.requirements) : undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      startedAt: row.started_at ?? undefined,
      completedAt: row.completed_at ?? undefined,
      result: row.result ? JSON.parse(row.result) : undefined,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    };
  }

  private rowToJob(row: JobRow): Job {
    return {
      id: row.id,
      taskId: row.task_id,
      nodeId: row.node_id,
      agentId: row.agent_id ?? undefined,
      status: row.status as JobStatus,
      createdAt: row.created_at,
      startedAt: row.started_at ?? undefined,
      completedAt: row.completed_at ?? undefined,
      allocatedCores: row.allocated_cores,
      allocatedRamMb: row.allocated_ram_mb,
      exitCode: row.exit_code ?? undefined,
      output: row.output ?? undefined,
      error: row.error ?? undefined,
    };
  }

  private rowToAgentRun(row: AgentRunRow): AgentRun {
    return {
      id: row.id,
      nodeId: row.node_id,
      jobId: row.job_id ?? undefined,
      taskId: row.task_id ?? undefined,
      adapter: row.adapter,
      status: row.status as AgentRunStatus,
      startedAt: row.started_at,
      completedAt: row.completed_at ?? undefined,
      peakRamMb: row.peak_ram_mb ?? undefined,
      cpuSeconds: row.cpu_seconds ?? undefined,
      exitCode: row.exit_code ?? undefined,
      output: row.output ?? undefined,
    };
  }
}

// Database row types
interface NodeRow {
  id: string;
  name: string;
  status: string;
  capacity_cores: number;
  capacity_ram_mb: number;
  capacity_disk_gb: number;
  capacity_gpu_count: number;
  container_runtime: string | null;
  used_cores: number;
  used_ram_mb: number;
  active_jobs: number;
  last_heartbeat: string | null;
  registered_at: string;
  version: string | null;
  os: string | null;
  arch: string | null;
}

interface TaskRow {
  id: string;
  type: string;
  priority: number;
  status: string;
  title: string;
  description: string | null;
  assigned_node: string | null;
  assigned_agent: string | null;
  job_id: string | null;
  requirements: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  result: string | null;
  metadata: string | null;
}

interface JobRow {
  id: string;
  task_id: string;
  node_id: string;
  agent_id: string | null;
  status: string;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  allocated_cores: number;
  allocated_ram_mb: number;
  exit_code: number | null;
  output: string | null;
  error: string | null;
}

interface EventRow {
  id: string;
  type: string;
  timestamp: string;
  data: string;
}

interface AgentRunRow {
  id: string;
  node_id: string;
  job_id: string | null;
  task_id: string | null;
  adapter: string;
  status: string;
  started_at: string;
  completed_at: string | null;
  peak_ram_mb: number | null;
  cpu_seconds: number | null;
  exit_code: number | null;
  output: string | null;
}

// Global singleton instance
let globalStore: Store | null = null;

/**
 * Get or create the global store instance.
 */
export function getStore(config?: StoreConfig): Store {
  if (!globalStore) {
    const dbPath = config?.dbPath ?? join(process.cwd(), "data", "lair.db");
    globalStore = new Store({ dbPath, ...config });
  }
  return globalStore;
}

/**
 * Close the global store.
 */
export function closeStore(): void {
  globalStore?.close();
  globalStore = null;
}
