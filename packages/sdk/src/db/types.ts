export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type SqlValue = JsonValue | Uint8Array | Date;

export type Row = Record<string, unknown>;

export type ExecuteResult = {
  rows: Row[];
  rowsAffected: number;
};

export interface AcrmDatabase {
  execute(
    sql: string,
    params?: ReadonlyArray<SqlValue>,
  ): Promise<ExecuteResult>;
  transaction<T>(fn: (db: AcrmDatabase) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
