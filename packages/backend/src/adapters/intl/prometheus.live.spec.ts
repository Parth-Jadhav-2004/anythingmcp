import axios from 'axios';
import * as adapter from './prometheus.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { applyResponseTransform, validateTransform } from '../../connectors/response-transform.util';
import { assertNoResponseBodyError } from '../../connectors/engines/response-error.util';
import { describeAdapterEnvVars } from '../env-var-meta';
import { getAdapter, listAdapters } from '../catalog';

/**
 * Two layers of verification for the Prometheus adapter:
 *
 *   1. Static: always runs. Pins the address of the server as an env var, the
 *      optional Authorization header (sent only when it is set), every tool's
 *      method, URL and query parameters through the real RestEngine, the
 *      response mapping of each tool, and the rule that turns a
 *      {"status":"error"} body into a failed call.
 *
 *   2. Live: skipped unless RUN_PROMETHEUS_LIVE=1. It needs PROMETHEUS_URL
 *      to point at a running Prometheus (its own server, a staging one, or a
 *      local `docker run prom/prometheus`); PROMETHEUS_AUTHORIZATION is
 *      optional and only for a server or proxy that asks for one. A server
 *      that demands authentication is checked with
 *      PROMETHEUS_LIVE_AUTH_REQUIRED=1: the call must be refused without the
 *      header and answered with it.
 *
 *        RUN_PROMETHEUS_LIVE=1 npx jest src/adapters/intl/prometheus.live.spec.ts
 */

jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  const mocked = jest.fn();
  return {
    __esModule: true,
    default: Object.assign(mocked, actual.default, { __actual: actual.default }),
    AxiosError: actual.AxiosError,
  };
});
const mockedAxios = axios as unknown as jest.Mock & { __actual: typeof axios };

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters: { properties?: Record<string, { description?: string; default?: unknown }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: Record<string, unknown>; headers?: Record<string, string> };
  responseMapping?: Record<string, any>;
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  unlisted?: boolean;
  name: string;
  description: string;
  category: string;
  icon: string;
  region: string;
  docsUrl: string;
  instructions: string;
  requiredEnvVars: string[];
  optionalEnvVars: string[];
  envVarMeta: Record<string, { pattern?: string; kind?: string; secret?: boolean }>;
  verifyHints: Record<string, string>;
  probe: { tool: string };
  connector: { type: string; baseUrl: string; authType: string; authConfig?: Record<string, string>; headers: Record<string, string>; healthcheckPath?: string; config?: { errorWhen?: unknown } };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
const annotationsOf = (t: Tool) =>
  deriveToolAnnotations({ name: t.name, connectorType: 'REST', endpointMapping: t.endpointMapping, annotations: t.annotations });

const ENV: Record<string, string> = { PROMETHEUS_URL: 'http://prometheus.example.com:9090' };
const API = 'http://prometheus.example.com:9090';

// Mirrors DynamicMcpTools: {{VAR}} interpolated in the connector and the
// mapping, connector variables and schema defaults merged into the params.
const call = (name: string, params: Record<string, unknown>, env = ENV) => {
  const { config, endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
    tool(name).endpointMapping,
    env,
  );
  return new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
    {
      baseUrl: config.baseUrl,
      authType: a.connector.authType,
      authConfig: interpolateDeep(a.connector.authConfig ?? {}, env),
      headers: config.headers,
      // The rules the connector stores with it: an error body Prometheus sends
      // with 200 has to fail the call.
      errorWhen: a.connector.config?.errorWhen,
    } as any,
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters as any, params), ...env },
  ) as Promise<any>;
};
const shape = (name: string, raw: unknown) => applyResponseTransform(raw, tool(name).responseMapping as any).value as any;
const shaped = async (name: string, params: Record<string, unknown>, env = ENV) => shape(name, await call(name, params, env));
const sent = () => mockedAxios.mock.calls[0][0];
const query = () => {
  const req = sent();
  return req.paramsSerializer ? decodeURIComponent(req.paramsSerializer(req.params)) : '';
};

describe('prometheus adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed and reads the server address from an env var', () => {
    expect(a.unlisted).toBeFalsy();
    expect(a.name).toBe('Prometheus');
    expect(a.category).toBe('monitoring');
    expect(a.icon).toBe('prometheus');
    expect(a.region).toBe('intl');
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe('{{PROMETHEUS_URL}}');
    // Most Prometheus servers need no authentication, so the connector sends
    // no credentials of its own.
    expect(a.connector.authType).toBe('NONE');
    expect(a.connector.authConfig).toBeUndefined();
    expect(a.connector.healthcheckPath).toBe('/api/v1/status/buildinfo');
    expect(a.probe.tool).toBe('prometheus_get_build_info');
    expect(a.requiredEnvVars).toEqual(['PROMETHEUS_URL']);
    expect(a.optionalEnvVars).toEqual(['PROMETHEUS_AUTHORIZATION']);
    const meta = Object.fromEntries(describeAdapterEnvVars(a as never).map((m) => [m.name, m]));
    expect(meta.PROMETHEUS_URL).toMatchObject({ kind: 'address', secret: false, required: true });
    expect(meta.PROMETHEUS_AUTHORIZATION).toMatchObject({ kind: 'credential', secret: true, required: false });
  });

  it('accepts a plain, a TLS and a sub-path server address, and refuses one without a scheme', () => {
    const url = new RegExp(a.envVarMeta.PROMETHEUS_URL.pattern!);
    for (const ok of [
      'http://prometheus.example.com:9090',
      'https://prometheus.example.com',
      'https://example.com/prometheus',
      'http://localhost:9090',
    ]) {
      expect(`${ok}:${url.test(ok)}`).toBe(`${ok}:true`);
    }
    for (const bad of ['prometheus.example.com', 'http://prometheus.example.com:9090/', 'http://prometheus.example.com:9090/api/v1']) {
      expect(`${bad}:${url.test(bad)}`).toBe(`${bad}:false`);
    }
  });

  it('explains the failures a Prometheus answers with', () => {
    for (const status of ['400', '401', '403', '404', '422', '503']) expect(a.verifyHints[status]).toBeTruthy();
    expect(a.verifyHints['401']).toMatch(/PROMETHEUS_AUTHORIZATION/);
    expect(a.verifyHints['404']).toMatch(/PROMETHEUS_URL/);
  });

  it('prefixes every tool with prometheus_ and shares no tool name with another adapter', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^prometheus_[a-z_]+$/);
    for (const meta of listAdapters()) {
      if (meta.slug === a.slug) continue;
      for (const t of getAdapter(meta.slug)!.tools) expect(mine.has(t.name)).toBe(false);
    }
  });

  it('is read-only: every tool is a GET and says so', () => {
    for (const t of a.tools) {
      expect(`${t.name}:${t.endpointMapping.method}`).toBe(`${t.name}:GET`);
      expect(`${t.name}:${annotationsOf(t).readOnlyHint}`).toBe(`${t.name}:true`);
    }
    expect(a.tools.some((t) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(t.endpointMapping.method))).toBe(false);
  });

  it('tells the model that this is Prometheus and not Grafana, and names every tool', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bprometheus_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bprometheus_[a-z_]+/g)]),
    ].map((m) => m[0]);
    for (const name of mentioned) expect(names).toContain(name);
    for (const name of names) expect(a.instructions).toContain(`\`${name}\``);
    expect(a.description).toMatch(/directly/);
    expect(a.description).toMatch(/not Grafana/);
    expect(a.instructions).toMatch(/not Grafana/);
    expect(a.instructions).toContain('PROMETHEUS_URL');
    expect(a.instructions).toContain('PROMETHEUS_AUTHORIZATION');
    // The cloud calls the server from the internet, so the address has to be
    // reachable from there.
    expect(a.instructions).toMatch(/reachable from the internet/);
    expect(a.instructions).toMatch(/absolute timestamps/);
    for (const t of a.tools) {
      expect(t.description.length).toBeGreaterThanOrEqual(60);
      for (const [p, schema] of Object.entries(t.parameters.properties ?? {})) {
        expect(`${t.name}.${p}:${typeof schema.description}`).toBe(`${t.name}.${p}:string`);
      }
    }
  });

  it('gives every tool a valid response mapping that does real work', () => {
    for (const t of a.tools) {
      const tr = t.responseMapping?.transform;
      expect(`${t.name}:${!!tr}`).toBe(`${t.name}:true`);
      expect(validateTransform(tr)).toBeNull();
      expect(tr.select ?? tr.exclude ?? tr.include ?? tr.expression).toBeDefined();
      expect(typeof tr.maxBytes).toBe('number');
    }
  });

  const table: Array<[string, Record<string, unknown>, string, string]> = [
    ['prometheus_query', { query: 'up' }, 'GET', '/api/v1/query'],
    ['prometheus_query_range', { query: 'up', start: '1760482800', end: '1760486400' }, 'GET', '/api/v1/query_range'],
    ['prometheus_format_query', { query: 'up' }, 'GET', '/api/v1/format_query'],
    ['prometheus_series', { match: 'up' }, 'GET', '/api/v1/series'],
    ['prometheus_label_names', {}, 'GET', '/api/v1/labels'],
    ['prometheus_label_values', { label: 'job' }, 'GET', '/api/v1/label/job/values'],
    ['prometheus_list_targets', {}, 'GET', '/api/v1/targets'],
    ['prometheus_list_metric_metadata', {}, 'GET', '/api/v1/metadata'],
    ['prometheus_list_alert_rules', {}, 'GET', '/api/v1/rules'],
    ['prometheus_list_active_alerts', {}, 'GET', '/api/v1/alerts'],
    ['prometheus_get_build_info', {}, 'GET', '/api/v1/status/buildinfo'],
  ];

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s to the right URL', async (name, params, method, path) => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call(name, params);
    expect(mockedAxios).toHaveBeenCalledTimes(1);
    const req = sent();
    expect(req.method).toBe(method);
    expect(req.url).toBe(`${API}${path}`);
    expect(JSON.stringify(req)).not.toContain('{{');
  });

  it('sends the query parameters the Prometheus API expects', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('prometheus_query', { query: 'up{job="api"}', time: '1760486400' });
    expect(query()).toBe('query=up{job="api"}&time=1760486400');
    mockedAxios.mockClear();
    // The step has a default, so a range query without one still asks for
    // points a minute apart.
    await call('prometheus_query_range', { query: 'up', start: '1760482800', end: '1760486400' });
    expect(query()).toBe('query=up&start=1760482800&end=1760486400&step=60s');
    mockedAxios.mockClear();
    // The Prometheus API calls the selector match[].
    await call('prometheus_series', { match: 'job="api"' });
    expect(query()).toBe('match[]=job="api"');
    mockedAxios.mockClear();
    await call('prometheus_list_targets', { state: 'any' });
    expect(query()).toBe('state=any');
    mockedAxios.mockClear();
    await call('prometheus_list_alert_rules', { type: 'alert', exclude_alerts: true });
    expect(query()).toBe('type=alert&exclude_alerts=true');
  });

  it('leaves the Authorization header out until it is set, and sends it when it is', async () => {
    mockedAxios.mockResolvedValue({ data: {} });
    await call('prometheus_get_build_info', {});
    expect(sent().headers.Authorization).toBeUndefined();
    mockedAxios.mockClear();
    await call('prometheus_get_build_info', {}, { ...ENV, PROMETHEUS_AUTHORIZATION: 'Basic dXNlcjpwYXNz' });
    expect(sent().headers.Authorization).toBe('Basic dXNlcjpwYXNz');
  });

  it('turns an error body Prometheus sends with 200 into a failed call', async () => {
    mockedAxios.mockResolvedValue({
      data: { status: 'error', errorType: 'bad_data', error: 'invalid parameter "query"' },
    });
    await expect(call('prometheus_query', { query: 'up' })).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining('invalid parameter'),
    });
    const rules = a.connector.config?.errorWhen;
    expect(rules).toBeDefined();
    expect(() => assertNoResponseBodyError({ status: 'success', data: {} }, rules)).not.toThrow();
    try {
      assertNoResponseBodyError({ status: 'error', errorType: 'bad_data', error: 'invalid parameter "query"' }, rules);
      throw new Error('the error body was accepted');
    } catch (e: any) {
      expect(e.status).toBe(400);
      expect(e.message).toMatch(/invalid parameter/);
    }
  });

  it('shapes an instant query into one entry per series', () => {
    const out = shape('prometheus_query', {
      status: 'success',
      data: {
        resultType: 'vector',
        result: [
          { metric: { __name__: 'up', job: 'api' }, value: [1760486400.781, '1'] },
          { metric: { __name__: 'up', job: 'web' }, value: [1760486400.781, '0'] },
        ],
      },
    });
    expect(out).toEqual([
      { labels: { __name__: 'up', job: 'api' }, value: '1', timestamp: 1760486400.781 },
      { labels: { __name__: 'up', job: 'web' }, value: '0', timestamp: 1760486400.781 },
    ]);
  });

  it('shapes a scalar result, which Prometheus answers with one entry and no labels', () => {
    // Prometheus answers a scalar with data.result = [timestamp, value], not
    // with a list of series.
    const out = shape('prometheus_query', { status: 'success', data: { resultType: 'scalar', result: [1760486400.781, '3'] } });
    expect(out).toEqual([{ value: '3', timestamp: 1760486400.781 }]);
    const str = shape('prometheus_query', { status: 'success', data: { resultType: 'string', result: [1760486400.781, 'hello'] } });
    expect(str).toEqual([{ value: 'hello', timestamp: 1760486400.781 }]);
  });

  it('shapes a range query into one list of points per series', () => {
    const out = shape('prometheus_query_range', {
      status: 'success',
      data: {
        resultType: 'matrix',
        result: [{ metric: { __name__: 'up', job: 'api' }, values: [[1760486340, '1'], [1760486400, '1']] }],
      },
    });
    expect(out).toEqual([{ labels: { __name__: 'up', job: 'api' }, points: [[1760486340, '1'], [1760486400, '1']] }]);
  });

  it('shapes the discovery endpoints into plain lists', () => {
    expect(shape('prometheus_label_names', { status: 'success', data: ['__name__', 'job'] })).toEqual(['__name__', 'job']);
    expect(shape('prometheus_label_values', { status: 'success', data: ['api', 'web'] })).toEqual(['api', 'web']);
    expect(shape('prometheus_series', { status: 'success', data: [{ __name__: 'up', job: 'api' }] })).toEqual([{ __name__: 'up', job: 'api' }]);
    expect(shape('prometheus_list_metric_metadata', { status: 'success', data: { up: { type: 'gauge', help: 'is it up', unit: '' } } })).toEqual({
      up: { type: 'gauge', help: 'is it up', unit: '' },
    });
  });

  it('shapes the scrape targets with their health and their last error', () => {
    const out = shape('prometheus_list_targets', {
      status: 'success',
      data: {
        activeTargets: [
          {
            labels: { job: 'api', instance: 'api-1:8080' },
            health: 'up',
            lastError: '',
            lastScrape: '2026-10-21T12:00:00.781Z',
            lastScrapeDuration: 0.015,
            scrapeInterval: '15s',
            scrapeUrl: 'http://api-1:8080/metrics',
            scrapePool: 'api',
          },
        ],
        droppedTargets: [],
      },
    });
    expect(out.active).toEqual([
      {
        labels: { job: 'api', instance: 'api-1:8080' },
        health: 'up',
        lastError: '',
        lastScrape: '2026-10-21T12:00:00.781Z',
        lastScrapeDuration: 0.015,
        scrapeInterval: '15s',
        scrapeUrl: 'http://api-1:8080/metrics',
        scrapePool: 'api',
      },
    ]);
    expect(out.dropped).toEqual([]);
  });

  it('shapes the alerting rules with their group and their state', () => {
    const out = shape('prometheus_list_alert_rules', {
      status: 'success',
      data: {
        groups: [
          {
            name: 'api.rules',
            file: '/etc/prometheus/rules.yml',
            interval: 30,
            rules: [
              { name: 'HighErrorRate', type: 'alerting', state: 'firing', health: 'ok', query: 'rate(errors[5m]) > 1', duration: 300, labels: { severity: 'critical' }, annotations: { summary: 'too many errors' } },
            ],
          },
        ],
      },
    });
    expect(out).toEqual([
      {
        name: 'api.rules',
        file: '/etc/prometheus/rules.yml',
        interval: 30,
        rules: [
          {
            name: 'HighErrorRate',
            type: 'alerting',
            state: 'firing',
            health: 'ok',
            query: 'rate(errors[5m]) > 1',
            duration: 300,
            labels: { severity: 'critical' },
            annotations: { summary: 'too many errors' },
            alerts: null,
          },
        ],
      },
    ]);
  });
});

const live = process.env.RUN_PROMETHEUS_LIVE === '1' ? describe : describe.skip;
live('prometheus adapter: live', () => {
  const url = process.env.PROMETHEUS_URL;
  const env = () => ({
    PROMETHEUS_URL: url!,
    ...(process.env.PROMETHEUS_AUTHORIZATION ? { PROMETHEUS_AUTHORIZATION: process.env.PROMETHEUS_AUTHORIZATION } : {}),
  });
  beforeAll(() => mockedAxios.mockImplementation((cfg: any) => (mockedAxios.__actual as any).request(cfg)));
  afterAll(() => mockedAxios.mockReset());

  it('needs a server to talk to', () => {
    expect(typeof url).toBe('string');
    expect(url).toBeTruthy();
  });

  it('reads the version of the server', async () => {
    const out = await shaped('prometheus_get_build_info', {}, env());
    expect(typeof out.version).toBe('string');
  }, 30000);

  it('runs an instant query', async () => {
    const out = await shaped('prometheus_query', { query: 'up' }, env());
    expect(Array.isArray(out)).toBe(true);
    expect(out.length).toBeGreaterThan(0);
    expect(typeof out[0].value).toBe('string');
  }, 60000);

  it('runs a range query over a short window', async () => {
    const end = Math.floor(Date.now() / 1000);
    const start = end - 600;
    const out = await shaped('prometheus_query_range', { query: 'up', start: String(start), end: String(end), step: '60s' }, env());
    expect(Array.isArray(out)).toBe(true);
  }, 60000);

  it('runs a scalar query', async () => {
    // Prometheus answers a scalar with one entry, without labels.
    const out = await shaped('prometheus_query', { query: 'time()' }, env());
    expect(Array.isArray(out)).toBe(true);
    expect(out.length).toBe(1);
    expect(typeof out[0].value).toBe('string');
    expect(typeof out[0].timestamp).toBe('number');
  }, 30000);

  it('parses a PromQL expression without running it', async () => {
    const out = await shaped('prometheus_format_query', { query: 'sum by (job) (rate(http_requests_total[5m]))' }, env());
    expect(out.query).toBe('sum by (job) (rate(http_requests_total[5m]))');
  }, 30000);

  it('fails a query Prometheus cannot parse', async () => {
    await expect(call('prometheus_query', { query: 'up{' }, env())).rejects.toBeTruthy();
  }, 30000);

  it('lists the labels, the series and the scrape targets', async () => {
    expect(Array.isArray(await shaped('prometheus_label_names', {}, env()))).toBe(true);
    expect(Array.isArray(await shaped('prometheus_label_values', { label: 'job' }, env()))).toBe(true);
    expect(Array.isArray(await shaped('prometheus_series', { match: 'up' }, env()))).toBe(true);
    const targets = await shaped('prometheus_list_targets', {}, env());
    expect(Array.isArray(targets.active)).toBe(true);
  }, 60000);

  it('lists the alerting rules', async () => {
    const out = await shaped('prometheus_list_alert_rules', {}, env());
    expect(Array.isArray(out)).toBe(true);
  }, 30000);

  // Only for a server that asks for authentication: PROMETHEUS_URL points at
  // one and PROMETHEUS_AUTHORIZATION carries the header it expects.
  const authRequired = process.env.PROMETHEUS_LIVE_AUTH_REQUIRED === '1';
  (authRequired ? it : it.skip)('is refused without the Authorization header and answers with it', async () => {
    await expect(call('prometheus_get_build_info', {}, { PROMETHEUS_URL: url! })).rejects.toMatchObject({
      response: { status: 401 },
    });
    const out = await shaped('prometheus_get_build_info', {}, env());
    expect(typeof out.version).toBe('string');
  }, 30000);
});
