import {
  DynamicModule,
  Module,
  Global,
  Provider,
  MiddlewareConsumer,
  RequestMethod,
  NestModule,
} from '@nestjs/common';
import { ProfilerOptions } from './common/profiler-options.interface';
import { ProfilerService } from './services/profiler.service';
import { ViewService } from './services/view.service';
import { TemplateBuilderService } from './services/template-builder.service';
import { EntityExplorerService } from './services/entity-explorer.service';
import { RouteExplorerService } from './services/route-explorer.service';
import { PostgresCollector } from './collectors/postgres-collector';
import { MongoCollector } from './collectors/mongo-collector';
import { MysqlCollector } from './collectors/mysql-collector';
import { LogCollector } from './collectors/log-collector';
import { CacheCollector } from './collectors/cache-collector';
import { HttpCollector } from './collectors/http-collector';
import { EventCollector } from './collectors/event-collector';
import { HealthService } from './services/health.service';
import { CodeQualityService } from './services/code-quality.service';
import { ExplainAnalyzer } from './analyzers/explain-analyzer';
import { InMemoryProfilerStorage } from './storage/in-memory-profiler-storage';
import { ProfilerController } from './controllers/profiler.controller';
import { RequestProfilerInterceptor } from './interceptors/request-profiler.interceptor';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ProfilerLogger } from './profiler-logger';
import { ProfilerMiddleware } from './middleware/profiler.middleware';
import { CronExplorerService } from './services/cron-explorer.service';
import { MemoryService } from './services/memory.service';
import { ErdService } from './services/erd.service';

@Global()
@Module({
  controllers: [ProfilerController],
  providers: [
    ProfilerService,
    ProfilerLogger,
    ViewService,
    TemplateBuilderService,
    EntityExplorerService,
    RouteExplorerService,
    CronExplorerService,
    MemoryService,
    ErdService,
  ],
  exports: [ProfilerService, EntityExplorerService, RouteExplorerService, CronExplorerService, MemoryService, ErdService],
})
export class ProfilerModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // Timing middleware — applied to all app routes except /__profiler
    consumer
      .apply(ProfilerMiddleware)
      .exclude({ path: '__profiler/(.*)', method: RequestMethod.ALL })
      .forRoutes({ path: '*', method: RequestMethod.ALL });
  }

  static forRoot(options: ProfilerOptions = {}): DynamicModule {
    const optionsProvider: Provider = {
      provide: 'PROFILER_OPTIONS',
      useValue: options,
    };

    const storageProvider: Provider = {
      provide: 'PROFILER_STORAGE',
      useValue:
        typeof options.storage === 'object' && options.storage !== null
          ? options.storage
          : new InMemoryProfilerStorage(),
    };

    return {
      module: ProfilerModule,
      imports: [],
      providers: [
        optionsProvider,
        storageProvider,
        ProfilerService,
        ViewService,
        TemplateBuilderService,
        EntityExplorerService,
        RouteExplorerService,
        PostgresCollector,
        MongoCollector,
        MysqlCollector,
        LogCollector,
        CacheCollector,
        HttpCollector,
        EventCollector,
        HealthService,
        CodeQualityService,
        CronExplorerService,
        MemoryService,
        ErdService,
        ExplainAnalyzer,
        {
          provide: APP_INTERCEPTOR,
          useClass: RequestProfilerInterceptor,
        },
      ],
      exports: [ProfilerService, MemoryService, ErdService],
    };
  }

  /**
   * Initialize the Entity & Route Explorer manually
   * Call this in your bootstrap function: ProfilerModule.initialize(app);
   */
  static initialize(app: any) {
    try {
      const container = app.container;
      const modulesContainer = container.getModules();

      // Entity Explorer
      const entityExplorer = app.get(EntityExplorerService);
      entityExplorer.initialize(modulesContainer);

      // Route Explorer
      const routeExplorer = app.get(RouteExplorerService);
      const globalPrefix = app.config?.getGlobalPrefix
        ? app.config.getGlobalPrefix()
        : '';
      routeExplorer.initialize(modulesContainer, globalPrefix);
    } catch (e) {
      console.warn(
        'Profiler: Could not initialize Explorers. Ensure ProfilerModule is imported.',
        e,
      );
    }

    // ── Cron Explorer ─────────────────────────────────────────────────────────
    // Optional — only active when @nestjs/schedule is installed and
    // ScheduleModule.forRoot() is imported in the host app.
    try {
      const cronExplorer = app.get(CronExplorerService);
      const container = app.container;
      const modulesContainer = container.getModules();

      let schedulerRegistry: any = null;
      try {
        // Avoid require('@nestjs/schedule') — it may not resolve from the profiler's
        // real path when the lib is symlinked. Instead, scan the DI container for a
        // provider whose constructor is named 'SchedulerRegistry'.
        for (const mod of modulesContainer.values()) {
          for (const wrapper of (mod as any).providers?.values() ?? []) {
            if (wrapper?.instance?.constructor?.name === 'SchedulerRegistry') {
              schedulerRegistry = wrapper.instance;
              break;
            }
          }
          if (schedulerRegistry) break;
        }
      } catch { /* @nestjs/schedule not installed or ScheduleModule not imported */ }

      cronExplorer.initialize(schedulerRegistry, modulesContainer);
    } catch { /* CronExplorerService not resolvable — skip */ }

    // ── Event listener name resolution ────────────────────────────────────────
    // @nestjs/event-emitter v2+ wraps @OnEvent handlers in anonymous arrow
    // functions, losing the method name.  We recover it by scanning providers
    // for the EVENT_LISTENER_METADATA reflect key (set by @OnEvent) and
    // building an event → [Class.method, ...] map that mirrors the registration
    // order used by EventSubscribersLoader.
    try {
      const eventCollector = app.get(EventCollector);
      const container = app.container;
      const modulesContainer = container.getModules();

      const EVENT_LISTENER_METADATA = 'EVENT_LISTENER_METADATA';
      // event name → ordered list of {name: "ClassName.method", file: "/path/to/file.ts"}
      const listenerMap = new Map<string, Array<{ name: string; file: string }>>();

      /** Find the source file for a class constructor via require.cache */
      const findFileForClass = (ctor: Function): string => {
        if (!ctor?.name) return '';
        try {
          const cache = (require as any).cache as Record<string, any>;
          for (const [filename, mod] of Object.entries(cache)) {
            if (!mod?.exports) continue;
            const exp = mod.exports;
            if (exp[ctor.name] === ctor) return filename.replace(/\.js$/, '.ts');
            if (exp?.default === ctor)   return filename.replace(/\.js$/, '.ts');
          }
        } catch { /* ignore */ }
        return '';
      };

      const scanInstance = (instance: any) => {
        if (!instance) return;
        const proto = Object.getPrototypeOf(instance);
        if (!proto || proto === Object.prototype) return;

        // Resolve the source file once per class
        const file = findFileForClass(instance.constructor);

        Object.getOwnPropertyNames(proto).forEach((methodKey) => {
          if (methodKey === 'constructor') return;
          try {
            const descriptor = Object.getOwnPropertyDescriptor(proto, methodKey);
            if (!descriptor || typeof descriptor.value !== 'function') return;
            const method = descriptor.value;
            const meta = Reflect.getMetadata(EVENT_LISTENER_METADATA, method);
            if (!meta) return;

            const metas: any[] = Array.isArray(meta) ? meta : [meta];
            metas.forEach((m: any) => {
              // event can be a string or an array of strings / patterns
              const events: string[] = Array.isArray(m.event)
                ? m.event
                : [m.event];
              const name = `${instance.constructor.name}.${methodKey}`;
              events.forEach((ev: string) => {
                const existing = listenerMap.get(ev) ?? [];
                existing.push({ name, file });
                listenerMap.set(ev, existing);
              });
            });
          } catch {
            // ignore reflection errors on individual methods
          }
        });
      };

      for (const mod of modulesContainer.values()) {
        const providers = [...(mod as any).providers.values()];
        for (const wrapper of providers) {
          if (!wrapper?.instance || wrapper.isAlias) continue;
          scanInstance(wrapper.instance);
        }
        const controllers = [...((mod as any).controllers?.values() ?? [])];
        for (const wrapper of controllers) {
          if (!wrapper?.instance || wrapper.isAlias) continue;
          scanInstance(wrapper.instance);
        }
      }

      eventCollector.setListenerNames(listenerMap);
    } catch {
      // EventCollector not available or @nestjs/event-emitter not installed — skip silently
    }

    // ── ERD — seed PostgresCollector from all TypeORM DataSources ────────────
    // Scan every DataSource in the DI container (there may be several — one per
    // named connection) and collect them all so ErdService can show a tab per DB.
    try {
      const pgCollector = app.get(PostgresCollector);
      const container = app.container;
      const modulesContainer = container.getModules();
      const seen = new Set<string>();

      for (const mod of modulesContainer.values()) {
        for (const wrapper of (mod as any).providers?.values() ?? []) {
          const inst = wrapper?.instance;
          if (!inst || inst.constructor?.name !== 'DataSource') continue;
          const opts = inst.options;
          if (!opts || opts.type !== 'postgres') continue;

          const cfg = {
            host:     opts.host     || 'localhost',
            port:     parseInt(String(opts.port || 5432)),
            database: opts.database as string,
            user:     opts.username || opts.user,
            password: opts.password,
            ...(opts.ssl !== undefined        ? { ssl: opts.ssl }       : {}),
            ...(opts.extra?.ssl !== undefined  ? { ssl: opts.extra.ssl } : {}),
          };

          // Deduplicate by host+database
          const key = `${cfg.host}:${cfg.port}/${cfg.database}`;
          if (seen.has(key)) continue;
          seen.add(key);

          // Human-readable label: use the TypeORM connection name if available
          const connName: string = (inst as any).name || opts.name || '';
          const label = connName && connName !== 'default'
            ? `${connName} (${cfg.database})`
            : cfg.database || 'PostgreSQL';

          pgCollector.allCapturedConfigs.push({ label, config: cfg });

          // Keep capturedConfig pointing at the first one for backwards-compat
          if (!pgCollector.capturedConfig) {
            pgCollector.capturedConfig = cfg;
          }
        }
      }
    } catch { /* PostgresCollector not registered or TypeORM not used — skip */ }
  }
}
