/**
 * Type declarations for sql.js (WebAssembly SQLite)
 */
declare module "sql.js" {
  export interface Database {
    run(sql: string, params?: unknown[]): Database;
    exec(sql: string): QueryExecResult[];
    prepare(sql: string): Statement;
    close(): void;
    export(): Uint8Array;
    getRowsModified(): number;
  }

  export interface Statement {
    bind(params?: unknown[]): boolean;
    step(): boolean;
    get(): (string | number | null)[];
    getAsObject(): Record<string, unknown>;
    free(): boolean;
    reset(): void;
  }

  export interface QueryExecResult {
    columns: string[];
    values: (string | number | null)[][];
  }

  export interface SqlJsStatic {
    Database: new (data?: ArrayLike<number>) => Database;
  }

  export interface InitSqlJsConfig {
    locateFile?: (file: string) => string;
  }

  export default function initSqlJs(config?: InitSqlJsConfig): Promise<SqlJsStatic>;
}
