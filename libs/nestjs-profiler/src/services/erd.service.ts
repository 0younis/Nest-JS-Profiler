import { Injectable, Logger, Optional, Inject } from '@nestjs/common';
import { EntityExplorerService } from './entity-explorer.service';
import { PostgresCollector } from '../collectors/postgres-collector';
import { MysqlCollector } from '../collectors/mysql-collector';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ErdColumn {
  name: string;
  type: string;        // sanitised type string safe for Mermaid
  nullable: boolean;
  isPrimary: boolean;
  isForeign: boolean;
}

export interface ErdTable {
  name: string;
  columns: ErdColumn[];
}

export interface ErdRelation {
  fromTable: string;   // table that holds the FK
  fromColumn: string;
  toTable: string;     // referenced (PK) table
  toColumn: string;
  cardinality: '1:1' | '1:N';
}

export type ErdSourceType = 'postgresql' | 'mysql' | 'entities';

export interface ErdSchema {
  source: ErdSourceType;
  label: string;         // display name for tab
  database?: string;     // e.g. "mydb@localhost"
  tableCount: number;
  relationCount: number;
  tables: ErdTable[];
  relations: ErdRelation[];
  mermaid: string;       // full erDiagram text ready to feed Mermaid.js
  error?: string;        // if schema query failed
}

// ─── Service ──────────────────────────────────────────────────────────────────

@Injectable()
export class ErdService {
  private readonly logger = new Logger(ErdService.name);

  /**
   * External PG/MySQL connection configs registered by app code via
   * registerPostgresConnection() / registerMysqlConnection().
   * Used when the app does NOT use TypeORM — e.g. raw pg.Pool or mysql2.
   */
  private readonly externalPgConfigs:    Array<{ label: string; config: Record<string, any> }> = [];
  private readonly externalMysqlConfigs: Array<{ label: string; config: Record<string, any> }> = [];

  constructor(
    private readonly entityExplorer: EntityExplorerService,
    @Optional() private readonly pgCollector: PostgresCollector,
    @Optional() private readonly mysqlCollector: MysqlCollector,
  ) {}

  /**
   * Register a PostgreSQL connection config so the ERD service can introspect
   * its schema without needing a prior profiled query.
   * Call this from your app's service after creating a pg.Pool / pg.Client.
   *
   * @param label  Tab label shown in the ERD UI (e.g. "PG: subscriptions")
   * @param config pg connection options (host, port, database, user, password)
   */
  registerPostgresConnection(label: string, config: Record<string, any>): void {
    const exists = this.externalPgConfigs.some(c => c.label === label);
    if (!exists) this.externalPgConfigs.push({ label, config });
  }

  /**
   * Register a MySQL connection config so the ERD service can introspect
   * its schema without needing a prior profiled query.
   *
   * @param label  Tab label shown in the ERD UI (e.g. "MySQL: orders")
   * @param config mysql2 connection options (host, port, database, user, password)
   */
  registerMysqlConnection(label: string, config: Record<string, any>): void {
    const exists = this.externalMysqlConfigs.some(c => c.label === label);
    if (!exists) this.externalMysqlConfigs.push({ label, config });
  }

  /**
   * Returns one ErdSchema per available data source.
   * Rules:
   *  - PostgreSQL tab: only if pgCollector is present (pgDriver was passed).
   *    Config is sourced from the first captured query OR from env vars as a fallback.
   *  - MySQL tab: only if mysqlCollector has an active capturedConfig
   *    (i.e. mysql2 was actually configured AND at least one query was made).
   *  - Entity fallback: shown only when no real DB schema could be produced.
   */
  async getSchemas(): Promise<ErdSchema[]> {
    const schemas: ErdSchema[] = [];

    // ── Externally registered PostgreSQL connections (raw pg.Pool / pg.Client) ─
    for (const { label, config } of this.externalPgConfigs) {
      const pg = await this.buildPostgresSchema(label, config);
      if (pg) schemas.push(pg);
    }

    // ── Externally registered MySQL connections (raw mysql2) ──────────────────
    for (const { label, config } of this.externalMysqlConfigs) {
      const my = await this.buildMysqlSchemaFromConfig(label, config);
      if (my) schemas.push(my);
    }

    // ── PostgreSQL via collector (TypeORM DataSources or captured queries) ─────
    if (this.pgCollector) {
      if (this.pgCollector.allCapturedConfigs.length > 0) {
        // Multiple named connections — one tab per DataSource
        for (const { label, config } of this.pgCollector.allCapturedConfigs) {
          // Skip if already added via externalPgConfigs
          if (schemas.some(s => s.label === label)) continue;
          const pg = await this.buildPostgresSchema(label, config);
          if (pg) schemas.push(pg);
        }
      } else if (this.externalPgConfigs.length === 0) {
        // Fallback: single connection via capturedConfig or env vars
        if (!this.pgCollector.capturedConfig) {
          const envCfg = this.pgEnvConfig();
          if (envCfg) this.pgCollector.capturedConfig = envCfg;
        }
        const pg = await this.buildPostgresSchema('PostgreSQL', this.pgCollector.capturedConfig);
        if (pg) schemas.push(pg);
      }
    }

    // ── MySQL via collector (capturedConfig from first profiled query) ─────────
    if (this.mysqlCollector?.capturedConfig && this.externalMysqlConfigs.length === 0) {
      const my = await this.buildMysqlSchemaFromConfig('MySQL', this.mysqlCollector.capturedConfig);
      if (my) schemas.push(my);
    }

    // ── Entity fallback ────────────────────────────────────────────────────────
    if (schemas.length === 0) {
      schemas.push(this.buildEntityFallback());
    }

    return schemas;
  }

  /**
   * Try to build a pg connection config from common environment variables.
   * Supports DATABASE_URL as well as individual DB_* / POSTGRES_* / PG* vars.
   * Returns null if the minimum required info (database name) is not available.
   */
  private pgEnvConfig(): Record<string, any> | null {
    // DATABASE_URL (e.g. postgres://user:pass@host:5432/dbname)
    const url = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.PG_URL;
    if (url) {
      try {
        const u = new URL(url);
        if (u.pathname && u.pathname.length > 1) {
          return {
            host:     u.hostname || 'localhost',
            port:     parseInt(u.port || '5432'),
            database: u.pathname.slice(1),
            user:     u.username || undefined,
            password: u.password || undefined,
          };
        }
      } catch { /* invalid URL — fall through */ }
    }

    // Individual env vars — require at least DB_NAME / POSTGRES_DB / PGDATABASE
    const database =
      process.env.DB_NAME      ||
      process.env.POSTGRES_DB  ||
      process.env.PGDATABASE;

    if (!database) return null;

    return {
      host:     process.env.DB_HOST      || process.env.POSTGRES_HOST || process.env.PGHOST     || 'localhost',
      port:     parseInt(process.env.DB_PORT || process.env.POSTGRES_PORT || process.env.PGPORT || '5432'),
      database,
      user:     process.env.DB_USER      || process.env.POSTGRES_USER || process.env.PGUSER     || undefined,
      password: process.env.DB_PASSWORD  || process.env.POSTGRES_PASSWORD || process.env.PGPASSWORD || undefined,
    };
  }

  // ── PostgreSQL ─────────────────────────────────────────────────────────────

  private async buildPostgresSchema(label: string, cfg: Record<string, any> | null): Promise<ErdSchema | null> {
    // No config available — hide the tab
    if (!cfg) return null;

    // Temporarily swap capturedConfig so runSchemaQuery uses this specific connection
    const prev = this.pgCollector.capturedConfig;
    this.pgCollector.capturedConfig = cfg;

    try {
      // Columns + types
      const colRows = await this.pgCollector.runSchemaQuery(`
        SELECT c.table_name, c.column_name, c.data_type, c.is_nullable
        FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND EXISTS (
            SELECT 1 FROM information_schema.tables t
            WHERE t.table_schema = 'public' AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
          )
        ORDER BY c.table_name, c.ordinal_position
      `);

      if (!colRows || colRows.length === 0) {
        this.pgCollector.capturedConfig = prev;
        return {
          source: 'postgresql',
          label,
          tableCount: 0,
          relationCount: 0,
          tables: [],
          relations: [],
          mermaid: 'erDiagram\n  %% No tables found in the public schema',
          error: 'Connected successfully but no tables were found in the public schema.',
        };
      }

      // Primary keys
      const pkRows = await this.pgCollector.runSchemaQuery(`
        SELECT kcu.table_name, kcu.column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
        WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = 'public'
      `) ?? [];

      // Foreign keys
      const fkRows = await this.pgCollector.runSchemaQuery(`
        SELECT
          kcu.table_name,
          kcu.column_name,
          ccu.table_name  AS ref_table,
          ccu.column_name AS ref_column
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
        JOIN information_schema.constraint_column_usage ccu
          ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
        WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
      `) ?? [];

      // Unique constraints — FK columns that are also UNIQUE are 1:1 relationships
      const uniqueRows = await this.pgCollector.runSchemaQuery(`
        SELECT kcu.table_name, kcu.column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
        WHERE tc.constraint_type = 'UNIQUE' AND tc.table_schema = 'public'
      `) ?? [];

      this.pgCollector.capturedConfig = prev;
      return this.buildSchema('postgresql', label, colRows, pkRows, fkRows, uniqueRows);
    } catch (err: any) {
      this.pgCollector.capturedConfig = prev;
      this.logger.warn(`PostgreSQL ERD failed: ${err?.message}`);
      return null;
    }
  }

  // ── MySQL ──────────────────────────────────────────────────────────────────

  private async buildMysqlSchemaFromConfig(label: string, config: Record<string, any>): Promise<ErdSchema | null> {
    // Run queries using a temporary mysql2 connection built from the given config
    const runQuery = async (sql: string): Promise<any[] | null> => {
      if (this.mysqlCollector) {
        // Use the collector's driver (already resolved / injected)
        const prev = this.mysqlCollector.capturedConfig;
        this.mysqlCollector.capturedConfig = config;
        const rows = await this.mysqlCollector.runSchemaQuery(sql);
        this.mysqlCollector.capturedConfig = prev;
        return rows;
      }
      // No collector — try to resolve mysql2 ourselves
      try {
        const mysql = require('mysql2/promise');
        const conn = await mysql.createConnection(config);
        const [rows] = await conn.execute(sql);
        await conn.end();
        return rows as any[];
      } catch { return null; }
    };

    try {
      const db = config.database || 'DATABASE()';
      const dbExpr = config.database ? `'${config.database}'` : 'DATABASE()';

      // Alias all columns to lowercase — MySQL information_schema returns UPPERCASE
      // column names (TABLE_NAME, DATA_TYPE …) which would break the shared
      // buildSchema() helper that expects lowercase keys.
      const colRows = await runQuery(`
        SELECT
          c.TABLE_NAME    AS table_name,
          c.COLUMN_NAME   AS column_name,
          c.DATA_TYPE     AS data_type,
          c.IS_NULLABLE   AS is_nullable
        FROM information_schema.COLUMNS c
        WHERE c.TABLE_SCHEMA = ${dbExpr}
        ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION
      `);

      if (!colRows || colRows.length === 0) {
        return {
          source: 'mysql', label,
          tableCount: 0, relationCount: 0,
          tables: [], relations: [],
          mermaid: 'erDiagram\n  %% No tables found',
          error: `Connected to ${db} but no tables were found.`,
        };
      }

      const pkRows = await runQuery(`
        SELECT
          kcu.TABLE_NAME   AS table_name,
          kcu.COLUMN_NAME  AS column_name
        FROM information_schema.KEY_COLUMN_USAGE kcu
        JOIN information_schema.TABLE_CONSTRAINTS tc
          ON kcu.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
         AND kcu.TABLE_SCHEMA    = tc.TABLE_SCHEMA
        WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
          AND kcu.TABLE_SCHEMA   = ${dbExpr}
      `) ?? [];

      const fkRows = await runQuery(`
        SELECT
          kcu.TABLE_NAME              AS table_name,
          kcu.COLUMN_NAME             AS column_name,
          kcu.REFERENCED_TABLE_NAME   AS ref_table,
          kcu.REFERENCED_COLUMN_NAME  AS ref_column
        FROM information_schema.KEY_COLUMN_USAGE kcu
        WHERE kcu.TABLE_SCHEMA              = ${dbExpr}
          AND kcu.REFERENCED_TABLE_NAME     IS NOT NULL
      `) ?? [];

      return this.buildSchema('mysql', label, colRows, pkRows, fkRows);
    } catch (err: any) {
      this.logger.warn(`MySQL ERD (${label}) failed: ${err?.message}`);
      return null;
    }
  }

  // ── ORM Entity fallback ────────────────────────────────────────────────────

  private buildEntityFallback(): ErdSchema {
    const entities = this.entityExplorer.getEntities();

    if (entities.length === 0) {
      return {
        source: 'entities',
        label: 'ORM Entities',
        tableCount: 0,
        relationCount: 0,
        tables: [],
        relations: [],
        mermaid: 'erDiagram\n  %% No entities discovered. Call ProfilerModule.initialize(app) in your bootstrap function.',
        error: 'No entities found. Ensure ProfilerModule.initialize(app) is called and TypeORM/MikroORM is configured.',
      };
    }

    const tables: ErdTable[] = entities.map(e => ({
      name: e.tableName || e.name,
      columns: (e.columns || []).map(colName => ({
        name: colName,
        type: 'varchar',
        nullable: true,
        isPrimary: colName === 'id',
        isForeign: false,
      })),
    }));

    const mermaid = this.toMermaid(tables, []);

    return {
      source: 'entities',
      label: 'ORM Entities',
      tableCount: tables.length,
      relationCount: 0,
      tables,
      relations: [],
      mermaid,
      error: tables.length > 0
        ? 'Showing ORM entity structure only — no database connected. FK relationships are not available without a live DB connection.'
        : undefined,
    };
  }

  // ── Shared schema builder ──────────────────────────────────────────────────

  private buildSchema(
    source: ErdSourceType,
    label: string,
    colRows: any[],
    pkRows: any[],
    fkRows: any[],
    uniqueRows: any[] = [],
  ): ErdSchema {
    // Build PK set: "tableName.columnName"
    const pkSet = new Set<string>(
      pkRows.map((r: any) => `${r.table_name}.${r.column_name}`)
    );

    // Build FK set
    const fkSet = new Set<string>(
      fkRows.map((r: any) => `${r.table_name}.${r.column_name}`)
    );

    // Build UNIQUE set — used to detect 1:1 relationships
    const uniqueSet = new Set<string>(
      uniqueRows.map((r: any) => `${r.table_name}.${r.column_name}`)
    );

    // Group columns by table
    const tableMap = new Map<string, ErdTable>();
    for (const row of colRows) {
      const tName: string = row.table_name;
      if (!tableMap.has(tName)) tableMap.set(tName, { name: tName, columns: [] });
      tableMap.get(tName)!.columns.push({
        name: row.column_name,
        type: this.sanitiseType(row.data_type),
        nullable: row.is_nullable === 'YES',
        isPrimary: pkSet.has(`${tName}.${row.column_name}`),
        isForeign: fkSet.has(`${tName}.${row.column_name}`),
      });
    }

    const tables = [...tableMap.values()];

    // Build relations — determine 1:1 vs 1:N via UNIQUE constraint on FK column
    const relations: ErdRelation[] = fkRows.map((r: any) => ({
      fromTable:   r.table_name,
      fromColumn:  r.column_name,
      toTable:     r.ref_table,
      toColumn:    r.ref_column,
      cardinality: uniqueSet.has(`${r.table_name}.${r.column_name}`) ? '1:1' : '1:N',
    }));

    const mermaid = this.toMermaid(tables, relations);

    return {
      source,
      label,
      tableCount: tables.length,
      relationCount: relations.length,
      tables,
      relations,
      mermaid,
    };
  }

  // ── Mermaid generator ──────────────────────────────────────────────────────

  private toMermaid(tables: ErdTable[], relations: ErdRelation[]): string {
    const lines: string[] = ['erDiagram'];

    for (const table of tables) {
      lines.push(`  ${this.safeName(table.name)} {`);
      for (const col of table.columns) {
        const pk = col.isPrimary ? ' PK' : col.isForeign ? ' FK' : '';
        lines.push(`    ${col.type} ${this.safeName(col.name)}${pk}`);
      }
      lines.push('  }');
    }

    // Deduplicate relations (some DBs return duplicates for composite FKs)
    const seen = new Set<string>();
    for (const rel of relations) {
      const key = `${rel.toTable}||${rel.fromTable}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (rel.cardinality === '1:1') {
        // Exactly one on both sides
        lines.push(`  ${this.safeName(rel.toTable)} ||--|| ${this.safeName(rel.fromTable)} : "1:1"`);
      } else {
        // One PK row → zero-or-more FK rows
        lines.push(`  ${this.safeName(rel.toTable)} ||--o{ ${this.safeName(rel.fromTable)} : "1:N"`);
      }
    }

    return lines.join('\n');
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  /**
   * Sanitise a PostgreSQL/MySQL data type string into a Mermaid-safe token.
   * Mermaid erDiagram column types must be a single word (no spaces, no parens).
   */
  private sanitiseType(raw: string): string {
    if (!raw) return 'varchar';
    const map: Record<string, string> = {
      'character varying':              'varchar',
      'character':                      'char',
      'timestamp without time zone':    'timestamp',
      'timestamp with time zone':       'timestamptz',
      'time without time zone':         'time',
      'time with time zone':            'timetz',
      'double precision':               'float8',
      'boolean':                        'bool',
      'integer':                        'int',
      'bigint':                         'bigint',
      'smallint':                       'smallint',
      'numeric':                        'numeric',
      'text':                           'text',
      'jsonb':                          'jsonb',
      'json':                           'json',
      'uuid':                           'uuid',
      'bytea':                          'bytea',
      'date':                           'date',
      'tinyint':                        'tinyint',
      'mediumint':                      'mediumint',
      'float':                          'float',
      'decimal':                        'decimal',
      'longtext':                       'longtext',
      'mediumtext':                     'mediumtext',
      'tinytext':                       'tinytext',
      'blob':                           'blob',
      'longblob':                       'longblob',
      'datetime':                       'datetime',
      'enum':                           'enum',
      'set':                            'set',
    };
    const lower = raw.toLowerCase();
    if (map[lower]) return map[lower];
    // Strip parentheses (e.g. "varchar(255)" → "varchar")
    return lower.replace(/\(.*\)/, '').replace(/\s+/g, '_');
  }

  /**
   * Sanitise table/column name for Mermaid (no spaces or special chars).
   */
  private safeName(name: string): string {
    return name.replace(/[^a-zA-Z0-9_]/g, '_');
  }
}
