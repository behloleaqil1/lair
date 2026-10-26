/**
 * Type declarations for sql.js
 */
declare module "sql.js" {
  export interface Database {
    run(sql: string, params?: (string | number | null)[]): void;
    exec(sql: string, params?: (string | number | null)[]): QueryExecResult[];
    export(): Uint8Array;
    close(): void;
  }

  export interface QueryExecResult {
    columns: string[];
    values: (string | number | null)[][];
  }

  export interface SqlJsStatic {
    Database: new (data?: ArrayLike<number>) => Database;
  }

  export default function initSqlJs(): Promise<SqlJsStatic>;
}
