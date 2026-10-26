/**
 * Database migrations for lair-server store.
 * Simple versioned SQL migrations.
 */

export interface Migration {
  version: number;
  name: string;
  up: string;
}

/**
 * All migrations in order.
 * Each migration has a version number, name, and SQL to execute.
 */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "initial_schema",
    up: `
      -- Nodes table
      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'offline',
        capacity_cores INTEGER NOT NULL DEFAULT 0,
        capacity_ram_mb INTEGER NOT NULL DEFAULT 0,
        capacity_disk_gb INTEGER NOT NULL DEFAULT 0,
        capacity_gpu_count INTEGER NOT NULL DEFAULT 0,
        container_runtime TEXT,
        used_cores INTEGER NOT NULL DEFAULT 0,
        used_ram_mb INTEGER NOT NULL DEFAULT 0,
        active_jobs INTEGER NOT NULL DEFAULT 0,
        last_heartbeat TEXT,
        registered_at TEXT NOT NULL,
        version TEXT,
        os TEXT,
        arch TEXT
      );

      -- Tasks table
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 2,
        status TEXT NOT NULL DEFAULT 'queued',
        title TEXT NOT NULL,
        description TEXT,
        assigned_node TEXT,
        assigned_agent TEXT,
        job_id TEXT,
        requirements TEXT, -- JSON
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        result TEXT, -- JSON
        metadata TEXT -- JSON
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority DESC);

      -- Jobs table
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        agent_id TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        allocated_cores INTEGER NOT NULL DEFAULT 1,
        allocated_ram_mb INTEGER NOT NULL DEFAULT 512,
        exit_code INTEGER,
        output TEXT,
        error TEXT,
        FOREIGN KEY (task_id) REFERENCES tasks(id),
        FOREIGN KEY (node_id) REFERENCES nodes(id)
      );
      CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
      CREATE INDEX IF NOT EXISTS idx_jobs_node ON jobs(node_id);

      -- Events table
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        data TEXT NOT NULL -- JSON
      );
      CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
      CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);

      -- Agent runs table
      CREATE TABLE IF NOT EXISTS agent_runs (
        id TEXT PRIMARY KEY,
        node_id TEXT NOT NULL,
        job_id TEXT,
        task_id TEXT,
        adapter TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        started_at TEXT NOT NULL,
        completed_at TEXT,
        peak_ram_mb INTEGER,
        cpu_seconds INTEGER,
        exit_code INTEGER,
        output TEXT,
        FOREIGN KEY (node_id) REFERENCES nodes(id),
        FOREIGN KEY (job_id) REFERENCES jobs(id),
        FOREIGN KEY (task_id) REFERENCES tasks(id)
      );
      CREATE INDEX IF NOT EXISTS idx_agent_runs_status ON agent_runs(status);
      CREATE INDEX IF NOT EXISTS idx_agent_runs_node ON agent_runs(node_id);

      -- Schema version table
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY
      );
      INSERT INTO schema_version (version) VALUES (1);
    `,
  },
  {
    version: 2,
    name: "m2_policy_tables",
    up: `
      -- Node keys table (for signed gate results)
      CREATE TABLE IF NOT EXISTS node_keys (
        node_id TEXT PRIMARY KEY,
        public_key TEXT NOT NULL,
        private_key TEXT, -- Only stored on the node itself, NULL on server
        generated_at TEXT NOT NULL,
        revoked_at TEXT,
        FOREIGN KEY (node_id) REFERENCES nodes(id)
      );

      -- Gate pipelines table
      CREATE TABLE IF NOT EXISTS gate_pipelines (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        name TEXT NOT NULL,
        config TEXT NOT NULL, -- JSON
        version_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_gate_pipelines_project ON gate_pipelines(project_id);

      -- Gate results table
      CREATE TABLE IF NOT EXISTS gate_results (
        id TEXT PRIMARY KEY,
        pipeline_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        commit_sha TEXT NOT NULL,
        branch TEXT NOT NULL,
        status TEXT NOT NULL,
        steps TEXT NOT NULL, -- JSON array
        selected_steps TEXT NOT NULL, -- JSON array
        duration_ms INTEGER NOT NULL,
        pipeline_version TEXT NOT NULL,
        signature TEXT NOT NULL,
        node_public_key TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        verified BOOLEAN DEFAULT FALSE,
        verification_errors TEXT, -- JSON array
        FOREIGN KEY (pipeline_id) REFERENCES gate_pipelines(id),
        FOREIGN KEY (node_id) REFERENCES nodes(id)
      );
      CREATE INDEX IF NOT EXISTS idx_gate_results_commit ON gate_results(commit_sha);
      CREATE INDEX IF NOT EXISTS idx_gate_results_project ON gate_results(project_id);
      CREATE INDEX IF NOT EXISTS idx_gate_results_status ON gate_results(status);

      -- Policy configs table
      CREATE TABLE IF NOT EXISTS policy_configs (
        project_id TEXT PRIMARY KEY,
        config TEXT NOT NULL, -- JSON
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      -- Merge records table (audit trail)
      CREATE TABLE IF NOT EXISTS merge_records (
        id TEXT PRIMARY KEY,
        pr_id TEXT NOT NULL,
        commit_sha TEXT NOT NULL,
        merge_commit_sha TEXT NOT NULL,
        policy_evaluation TEXT NOT NULL, -- JSON
        initiated_by TEXT NOT NULL,
        reason TEXT NOT NULL,
        merged_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_merge_records_pr ON merge_records(pr_id);
      CREATE INDEX IF NOT EXISTS idx_merge_records_commit ON merge_records(commit_sha);

      -- Revert records table
      CREATE TABLE IF NOT EXISTS revert_records (
        id TEXT PRIMARY KEY,
        original_merge_id TEXT NOT NULL,
        revert_commit_sha TEXT NOT NULL,
        reason TEXT NOT NULL,
        triggering_gate_id TEXT,
        automatic BOOLEAN NOT NULL,
        reverted_at TEXT NOT NULL,
        FOREIGN KEY (original_merge_id) REFERENCES merge_records(id)
      );
      CREATE INDEX IF NOT EXISTS idx_revert_records_merge ON revert_records(original_merge_id);

      UPDATE schema_version SET version = 2;
    `,
  },
];

/**
 * Get the current schema version from the database.
 */
export function getCurrentVersion(db: { prepare: (sql: string) => { get: () => { version: number } | undefined } }): number {
  try {
    const row = db.prepare("SELECT version FROM schema_version ORDER BY version DESC LIMIT 1").get();
    return row?.version ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Get pending migrations that need to be applied.
 */
export function getPendingMigrations(currentVersion: number): Migration[] {
  return MIGRATIONS.filter((m) => m.version > currentVersion);
}
