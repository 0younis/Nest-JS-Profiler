import { Injectable, OnModuleInit, Inject, Logger } from '@nestjs/common';
import type * as http from 'http';
import type { ProfilerOptions } from '../common/profiler-options.interface';
import { ProfilerService } from '../services/profiler.service';
import { HttpCallProfile } from '../common/profiler.model';

// Internal marker so we skip self-issued SSE/profiler requests
const PROFILER_INTERNAL_HEADER = 'x-profiler-internal';
const FETCH_PATCHED = Symbol.for('nestjs-profiler.fetch.patched');

@Injectable()
export class HttpCollector implements OnModuleInit {
    private readonly logger = new Logger(HttpCollector.name);

    constructor(
        private readonly profiler: ProfilerService,
        @Inject('PROFILER_OPTIONS') private readonly options: ProfilerOptions,
    ) { }

    onModuleInit() {
        if (this.options.collectHttp === false) return;

        const httpMod = require('http');
        const httpsMod = require('https');

        this.patchModule(httpMod, 'http');
        this.patchModule(httpsMod, 'https');
        this.patchFetch();
        this.logger.log('HTTP/HTTPS and fetch outbound request tracking enabled');
    }

    private patchFetch() {
        if (typeof globalThis.fetch !== 'function' || (globalThis.fetch as any)[FETCH_PATCHED]) return;

        const self = this;
        const originalFetch = globalThis.fetch.bind(globalThis);
        const patchedFetch: typeof fetch = async function (input, init) {
            const profile = self.profiler.getCurrentProfile();
            if (!profile) return originalFetch(input, init);

            const isRequest = typeof Request !== 'undefined' && input instanceof Request;
            const url = isRequest ? input.url : String(input);
            const parsedUrl = new URL(url);

            if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
                return originalFetch(input, init);
            }

            const headers = new Headers(init?.headers ?? (isRequest ? input.headers : undefined));
            if (headers.has(PROFILER_INTERNAL_HEADER) || parsedUrl.pathname.includes('/__profiler')) {
                return originalFetch(input, init);
            }

            const requestHeaders: Record<string, string> = {};
            headers.forEach((value, key) => requestHeaders[key] = value);

            const startTime = Date.now();
            const httpCall: HttpCallProfile = {
                method: (init?.method ?? (isRequest ? input.method : 'GET')).toUpperCase(),
                url,
                host: parsedUrl.host,
                path: parsedUrl.pathname + parsedUrl.search,
                protocol: parsedUrl.protocol === 'https:' ? 'https' : 'http',
                startTime,
                duration: 0,
                requestHeaders: self.sanitiseHeaders(requestHeaders),
            };

            try {
                const response = await originalFetch(input, init);
                const responseHeaders: Record<string, string> = {};
                response.headers.forEach((value, key) => responseHeaders[key] = value);
                httpCall.statusCode = response.status;
                httpCall.responseHeaders = self.sanitiseHeaders(responseHeaders);
                httpCall.duration = Date.now() - startTime;
                self.profiler.addHttpCall(httpCall);
                return response;
            } catch (error) {
                httpCall.duration = Date.now() - startTime;
                httpCall.error = error instanceof Error ? error.message : String(error);
                self.profiler.addHttpCall(httpCall);
                throw error;
            }
        };

        (patchedFetch as any)[FETCH_PATCHED] = true;
        globalThis.fetch = patchedFetch;
    }

    private patchModule(mod: any, protocol: 'http' | 'https') {
        if (mod.__profilerPatched) return;
        mod.__profilerPatched = true;

        const self = this;
        const originalRequest = mod.request.bind(mod);
        const originalGet = mod.get.bind(mod);

        mod.request = function (...args: any[]): http.ClientRequest {
            const startTime = Date.now();

            let method = 'GET';
            let host = '';
            let path = '/';
            let fullUrl = '';
            let reqHeaders: Record<string, any> = {};

            try {
                const first = args[0];
                if (typeof first === 'string' || first instanceof URL) {
                    const u = typeof first === 'string' ? new URL(first) : first;
                    host = u.hostname + (u.port ? `:${u.port}` : '');
                    path = u.pathname + u.search;
                    fullUrl = u.toString();
                    const opts = (args[1] && typeof args[1] === 'object' && typeof args[1] !== 'function') ? args[1] : {};
                    method = (opts?.method || 'GET').toUpperCase();
                    reqHeaders = opts?.headers || {};
                } else if (first && typeof first === 'object') {
                    method = (first.method || 'GET').toUpperCase();
                    host = first.hostname || first.host || 'localhost';
                    if (first.port && !String(host).includes(':')) host += `:${first.port}`;
                    path = first.path || '/';
                    const defaultPort = protocol === 'https' ? 443 : 80;
                    const portStr = first.port && first.port !== defaultPort ? `:${first.port}` : '';
                    fullUrl = `${protocol}://${first.hostname || first.host || 'localhost'}${portStr}${path}`;
                    reqHeaders = first.headers || {};
                }
            } catch (_) { /* best-effort parsing */ }

            if (reqHeaders[PROFILER_INTERNAL_HEADER] || fullUrl.includes('/__profiler')) {
                return originalRequest(...args);
            }

            const profile = self.profiler.getCurrentProfile();

            const req: http.ClientRequest = originalRequest(...args);

            if (profile) {
                const httpCall: HttpCallProfile = {
                    method,
                    url: fullUrl,
                    host,
                    path,
                    protocol,
                    startTime,
                    duration: 0,
                    requestHeaders: self.sanitiseHeaders(reqHeaders),
                };

                req.on('response', (res: http.IncomingMessage) => {
                    httpCall.statusCode = res.statusCode;
                    httpCall.responseHeaders = self.sanitiseHeaders(res.headers as any);

                    res.on('end', () => {
                        httpCall.duration = Date.now() - startTime;
                        self.profiler.addHttpCall(httpCall);
                    });

                    res.resume();
                });

                req.on('error', (err: Error) => {
                    httpCall.duration = Date.now() - startTime;
                    httpCall.error = err.message;
                    self.profiler.addHttpCall(httpCall);
                });
            }

            return req;
        };

        mod.get = function (...args: any[]): http.ClientRequest {
            const req = mod.request(...args);
            req.end();
            return req;
        };
    }

    private sanitiseHeaders(headers: Record<string, any>): Record<string, string> {
        const result: Record<string, string> = {};
        for (const [k, v] of Object.entries(headers || {})) {
            const lower = k.toLowerCase();
            if (lower === 'authorization' || lower === 'cookie' || lower === 'set-cookie') {
                result[k] = '[redacted]';
            } else {
                result[k] = Array.isArray(v) ? v.join(', ') : String(v ?? '');
            }
        }
        return result;
    }
}
