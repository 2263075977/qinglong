const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const {
  buildPlantBody,
  formatStatus,
  normalizeDefaultAction,
  parseArgs,
  runAuto,
  summarizeState,
} = require('./hyb-farm');

const NOW = Date.parse('2026-07-11T08:00:00+08:00');

function makeState(overrides = {}) {
  return {
    crops: {
      success: true,
      maxSlots: 4,
      crops: [
        {
          cropId: 'crop-mature',
          plotIndex: 0,
          seedId: 'golden_apple',
          plantedAt: '2026-07-10T00:00:00+08:00',
          maturesAt: '2026-07-11T07:00:00+08:00',
          conditions: [],
        },
        {
          cropId: 'crop-growing',
          plotIndex: 1,
          seedId: 'starfruit',
          plantedAt: '2026-07-11T07:00:00+08:00',
          maturesAt: '2026-07-11T12:00:00+08:00',
          conditions: ['thirsty'],
        },
      ],
    },
    seeds: {
      success: true,
      seeds: [
        { id: 'golden_apple', name: '金苹果', price: '100' },
        { id: 'starfruit', name: '杨桃', price: '200' },
      ],
    },
    inventory: {
      success: true,
      inventory: [
        { seedId: 'golden_apple', quantity: 3 },
        { seedId: 'starfruit', quantity: 1 },
      ],
    },
    energy: {
      success: true,
      data: { currentEnergy: 8, maxEnergy: 20 },
    },
    ...overrides,
  };
}

function makeConfig(overrides = {}) {
  return {
    accountName: '',
    defaultQuantity: null,
    defaultSeedId: 'golden_apple',
    maxPlant: null,
    plantBodyRaw: '',
    ...overrides,
  };
}

function makeArgs(overrides = {}) {
  return {
    maxPlant: null,
    quantity: null,
    seedId: '',
    ...overrides,
  };
}

test('环境变量默认动作在无 CLI 动作时生效，显式动作优先', () => {
  assert.equal(normalizeDefaultAction('AUTO'), 'auto');
  assert.equal(parseArgs([], 'auto').action, 'auto');
  assert.equal(parseArgs(['status'], 'auto').action, 'status');
  assert.throws(() => normalizeDefaultAction('invalid'), /HYB_FARM_DEFAULT_ACTION 无效/);
});

test('按真实 crops/maxSlots/maturesAt/conditions 契约统计地块', () => {
  const summary = summarizeState(makeState(), NOW);

  assert.deepEqual(summary.plotSummary, {
    total: 4,
    mature: 1,
    empty: 2,
    needsCare: 1,
    growing: 1,
  });
});

test('种子目录与仓库库存按 id/seedId 关联并补全名称', () => {
  const summary = summarizeState(makeState(), NOW);

  assert.deepEqual(summary.seeds, [
    { id: 'golden_apple', name: '金苹果', quantity: 3 },
    { id: 'starfruit', name: '杨桃', quantity: 1 },
  ]);
  assert.deepEqual(summary.inventory, [
    { id: 'golden_apple', name: '金苹果', quantity: 3 },
    { id: 'starfruit', name: '杨桃', quantity: 1 },
  ]);
});

test('体力读取 currentEnergy/maxEnergy 并显示当前值和上限', () => {
  const state = makeState();
  const summary = summarizeState(state, NOW);
  const text = formatStatus({ accountName: '测试账号' }, state);

  assert.equal(summary.energy, 8);
  assert.equal(summary.energyMax, 20);
  assert.match(text, /账号: 测试账号/);
  assert.match(text, /体力: 8\/20/);
});

test('自动补种数量不超过空地、配置上限和种子库存', () => {
  const summary = summarizeState(makeState({
    crops: { success: true, maxSlots: 10, crops: [] },
  }), NOW);

  assert.deepEqual(
    buildPlantBody(makeConfig({ maxPlant: 5 }), makeArgs(), summary),
    { seedId: 'golden_apple', quantity: 3 }
  );
  assert.deepEqual(
    buildPlantBody(makeConfig(), makeArgs({ quantity: 2 }), summary),
    { seedId: 'golden_apple', quantity: 2 }
  );
});

test('指定种子没有库存时跳过补种', () => {
  const summary = summarizeState(makeState(), NOW);

  assert.throws(
    () => buildPlantBody(makeConfig(), makeArgs({ seedId: 'missing_seed' }), summary),
    (error) => error.type === 'skipped' && /库存不足/.test(error.message)
  );
});

test('体力接口失败时保留具体原因', () => {
  const state = makeState({
    energy: { unavailable: true, error: 'HTTP 503 - GET /api/farm/energy/status' },
  });
  const summary = summarizeState(state, NOW);
  const text = formatStatus({ accountName: '' }, state);

  assert.equal(summary.energy, null);
  assert.match(summary.energyError, /HTTP 503/);
  assert.match(text, /体力: 不可用（HTTP 503/);
});

test('auto 真实执行按收获、护理、重新查询、补种顺序调用接口', async (t) => {
  const requests = [];
  let harvested = false;
  const server = http.createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      requests.push({ method: request.method, path: request.url, body });
      response.setHeader('Content-Type', 'application/json');

      if (request.method === 'GET' && request.url === '/api/farm/crops') {
        response.end(JSON.stringify({
          success: true,
          maxSlots: 2,
          crops: harvested ? [] : [{
            cropId: 'crop-1',
            plotIndex: 0,
            seedId: 'golden_apple',
            isMature: true,
            conditions: ['thirsty'],
          }],
        }));
        return;
      }
      if (request.method === 'GET' && request.url === '/api/farm/seeds') {
        response.end(JSON.stringify({
          success: true,
          seeds: [{ id: 'golden_apple', name: '金苹果', price: '1' }],
        }));
        return;
      }
      if (request.method === 'GET' && request.url === '/api/farm/inventory') {
        response.end(JSON.stringify({
          success: true,
          inventory: [{ seedId: 'golden_apple', quantity: 3 }],
        }));
        return;
      }
      if (request.method === 'GET' && request.url === '/api/farm/energy/status') {
        response.end(JSON.stringify({
          success: true,
          data: { currentEnergy: 8, maxEnergy: 20 },
        }));
        return;
      }
      if (request.method === 'POST' && request.url === '/api/farm/harvest-all') {
        harvested = true;
        response.end(JSON.stringify({ success: true, data: { harvested: 1 } }));
        return;
      }
      if (request.method === 'POST' && request.url === '/api/farm/care/all') {
        response.end(JSON.stringify({ success: true, data: { affected: 1 } }));
        return;
      }
      if (request.method === 'POST' && request.url === '/api/farm/plant-batch') {
        response.end(JSON.stringify({ success: true, data: { planted: 2 } }));
        return;
      }

      response.statusCode = 404;
      response.end(JSON.stringify({ success: false, error: 'not found' }));
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const config = {
    autoExecute: true,
    baseUrl: `http://127.0.0.1:${address.port}`,
    cookie: 'test-cookie',
    defaultQuantity: null,
    defaultSeedId: 'golden_apple',
    maxPlant: null,
    plantBodyRaw: '',
    timeoutMs: 2000,
  };

  const result = await runAuto(config, parseArgs(['auto']));
  const posts = requests.filter((request) => request.method === 'POST');

  assert.equal(result.dryRun, false);
  assert.deepEqual(posts.map((request) => request.path), [
    '/api/farm/harvest-all',
    '/api/farm/care/all',
    '/api/farm/plant-batch',
  ]);
  assert.deepEqual(JSON.parse(posts[2].body), { seedId: 'golden_apple', quantity: 2 });
  assert.deepEqual(result.results.map((item) => item.type), ['success', 'success', 'success']);
});
