'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const credentials = {
  username: 'test-private-user',
  password: 'test-private-password',
  reporterId: 'test-reporter-id',
};
const token = 'test-private-token';
const sensitive = `${credentials.username} ${credentials.password} ${token}`;

function response(status = 200, body = '') {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  };
}

const URLS = {
  token: 'https://api.enegic.com/createtoken',
  snapshot: 'https://api.enegic.com/getreporterpriceschemasettings/',
  set: 'https://api.enegic.com/setreporterpriceschemasettings/',
  calc: 'https://api.enegic.com/calculatepriceschemas',
  mode: 'https://api.enegic.com/addupdatezaptecreporter',
};
const endpoints = [
  [URLS.token, 'PUT'],
  [URLS.snapshot, 'PUT'],
  [URLS.set, 'PUT'],
  [URLS.calc, 'POST'],
  [URLS.mode, 'PUT'],
];
const stages = ['authentication', 'snapshot', 'period update', 'recalculation', 'mode update'];
const updateStages = ['period update', 'recalculation', 'mode update'];
const followUpStages = ['recalculation', 'mode update'];
const expectedBodies = { 'period update': '', recalculation: '[]', 'mode update': '' };
const originalSettings = {
  MaxPrice: -1,
  MinPrice: -1,
  WantedHours: 3,
  PriceArea: 'SE3',
  ChargingIntervals: [{ StartCharging: '22:00', EndCharging: '06:00' }],
  Inverted: false,
  SortDescending: false,
};

function successReplies(tokenBody = JSON.stringify({ TokenInfo: { Token: token } })) {
  return [
    response(200, tokenBody),
    response(200, JSON.stringify(originalSettings)),
    response(),
    response(200, '[]'),
    response(),
  ];
}

function stageReplies(stage, reply) {
  const index = stages.indexOf(stage);
  return [
    ...successReplies(JSON.stringify({ token })).slice(0, index),
    reply,
    ...(followUpStages.includes(stage) ? [response(), response(200, '[]')] : []),
  ];
}

function stageUrls(stage) {
  const index = stages.indexOf(stage);
  return [
    ...endpoints.slice(0, index + 1).map(([url]) => url),
    ...(followUpStages.includes(stage) ? [URLS.set, URLS.calc] : []),
  ];
}

for (const [file, startCharging, endCharging] of [
  ['opticharge-off.js', '07:00', '06:55'],
  ['opticharge-on.js', '19:00', '07:00'],
]) {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

  function run({
    config = credentials,
    replies = successReplies(),
    scriptSource = source,
  } = {}) {
    const calls = [];
    const logs = [];
    const settingsReads = [];
    const context = vm.createContext({
      global: {
        get(key) {
          settingsReads.push(key);
          return config;
        },
      },
      log: (...args) => logs.push(args.join(' ')),
      fetch: async (url, options) => {
        const index = calls.length;
        calls.push({ url, options });
        assert.ok(index < replies.length, 'Unexpected extra request or retry');
        const reply = replies[index];
        if (reply instanceof Error) throw reply;
        return reply;
      },
    });
    const completion = new vm.Script(`(async () => {\n${scriptSource}\n})()`, {
      filename: file,
    }).runInContext(context);
    return { completion, calls, logs, settingsReads };
  }

  async function expectFailure(options, expected, urls, prefix = `${startCharging}-${endCharging}`) {
    const expectedUrls = Array.isArray(urls) ? urls : endpoints.slice(0, urls).map(([url]) => url);
    const execution = run(options);
    await assert.rejects(execution.completion, error => {
      assert.match(error.message, expected);
      assert.ok(error.message.startsWith(`OptiCharge ${prefix}:`));
      assert.match(error.message, /Actual charging period is unconfirmed/);
      for (const secret of [credentials.username, credentials.password, token]) {
        assert.ok(!error.stack.includes(secret), 'Error leaked a secret');
      }
      return true;
    });
    assert.deepEqual(execution.calls.map(({ url }) => url), expectedUrls, 'Unexpected request order, retry, or rollback');
    assert.equal(execution.logs.length, expectedUrls.length, 'Each request logs exactly one line');
    for (const secret of [credentials.username, credentials.password, token]) {
      assert.ok(!execution.logs.join('\n').includes(secret), 'Log leaked a secret');
    }
    return execution;
  }

  test(`${file}: exact token/period/recalculation/mode contract and bounded requests`, async () => {
    const execution = run();
    assert.equal(await execution.completion, true);
    assert.deepEqual(execution.settingsReads, ['enegic.opticharge']);
    assert.equal(execution.calls.length, 5);

    const [authentication, snapshot, settings, recalculation, mode] = execution.calls;
    assert.equal(authentication.url, 'https://api.enegic.com/createtoken');
    assert.deepEqual(JSON.parse(authentication.options.body), {
      username: credentials.username,
      password: credentials.password,
    });
    assert.equal(authentication.options.headers['X-Authorization'], undefined);
    assert.equal(snapshot.url, URLS.snapshot);
    assert.deepEqual(JSON.parse(snapshot.options.body), { ItemId: credentials.reporterId });
    assert.equal(settings.url, 'https://api.enegic.com/setreporterpriceschemasettings/');
    assert.equal(settings.options.headers['X-Authorization'], token);
    const payload = JSON.parse(settings.options.body);
    assert.deepEqual(payload, {
      ItemId: credentials.reporterId,
      Parameters: JSON.stringify({
        MaxPrice: -1,
        MinPrice: -1,
        WantedHours: 4,
        PriceArea: 'SE3',
        ChargingIntervals: [{ StartCharging: startCharging, EndCharging: endCharging }],
        Inverted: false,
        SortDescending: false,
      }),
    });
    assert.equal(typeof payload.ItemId, 'string');
    assert.equal(typeof payload.Parameters, 'string');

    assert.equal(recalculation.url, 'https://api.enegic.com/calculatepriceschemas');
    assert.deepEqual(JSON.parse(recalculation.options.body), {
      ReporterIds: [credentials.reporterId],
    });

    assert.equal(mode.url, 'https://api.enegic.com/addupdatezaptecreporter');
    const modePayload = JSON.parse(mode.options.body);
    assert.deepEqual(modePayload, {
      ReporterId: credentials.reporterId,
      UserSettings: JSON.stringify({ Mode: 'Price', PreviousMode: 'Price' }),
    });
    assert.equal(typeof modePayload.UserSettings, 'string');

    execution.calls.forEach(({ url, options }, index) => {
      assert.equal(url, endpoints[index][0]);
      assert.equal(options.method, endpoints[index][1]);
      assert.equal(options.headers['X-Authorization'], index === 0 ? undefined : token);
      assert.equal(options.headers['Content-Type'], 'application/json');
      assert.equal(options.redirect, 'error');
      assert.equal(options.timeout, 5000);
      assert.equal(options.size, 65536);
    });
    const prefix = `OptiCharge ${startCharging}-${endCharging}:`;
    assert.deepEqual(execution.logs.slice(0, 5), [
      `${prefix} authentication HTTP 200`,
      `${prefix} snapshot HTTP 200, body ${JSON.stringify(JSON.stringify(originalSettings))}`,
      `${prefix} period update HTTP 200, body ""`,
      `${prefix} recalculation HTTP 200, body "[]"`,
      `${prefix} mode update HTTP 200, body ""`,
    ]);
    assert.equal(execution.logs.length, 6);
    assert.match(execution.logs[5], /period update, recalculation and Price mode accepted \(HTTP 200\)/);
    assert.match(execution.logs[5], /applied schedule is not independently verified/);
    for (const secret of [credentials.username, credentials.password, token]) {
      assert.ok(!execution.logs.join('').includes(secret));
    }
  });

  test(`${file}: never persists or reuses the token`, async () => {
    for (const freshToken of [token, 'another-token']) {
      const execution = run({
        replies: successReplies(JSON.stringify({ TokenInfo: { Token: freshToken } })),
      });
      await execution.completion;
      assert.equal(execution.calls[0].url, 'https://api.enegic.com/createtoken');
      for (const call of execution.calls.slice(1)) {
        assert.equal(call.options.headers['X-Authorization'], freshToken);
      }
    }
  });

  test(`${file}: supports the original top-level token example`, async () => {
    const execution = run({
      replies: successReplies(JSON.stringify({ token })),
    });
    await execution.completion;
    assert.equal(execution.calls[1].options.headers['X-Authorization'], token);
  });

  test(`${file}: prefers the observed nested token over the original shape`, async () => {
    const execution = run({
      replies: successReplies(JSON.stringify({ TokenInfo: { Token: token }, token: 'legacy-token' })),
    });
    await execution.completion;
    assert.equal(execution.calls[1].options.headers['X-Authorization'], token);
  });

  test(`${file}: preserves credential characters without trimming`, async () => {
    const config = { ...credentials, password: '  quotes"\\and spaces  ' };
    const execution = run({ config });
    await execution.completion;
    assert.equal(JSON.parse(execution.calls[0].options.body).password, config.password);
  });

  for (const config of [null, false, 'invalid', 123]) {
    test(`${file}: rejects absent/non-object config ${JSON.stringify(config)}`, async () => {
      await expectFailure({ config }, /missing enegic.opticharge settings/, 0);
    });
  }

  for (const key of ['username', 'password', 'reporterId']) {
    for (const value of [undefined, null, '', ' \n ', 123]) {
      test(`${file}: rejects invalid ${key} ${JSON.stringify(value)}`, async () => {
        await expectFailure({
          config: { ...credentials, [key]: value },
        }, new RegExp(`invalid ${key} setting`), 0);
      });
    }
  }

  for (const [key, placeholder] of [
    ['username', 'YOUR_USERNAME'],
    ['password', 'YOUR_PASSWORD'],
  ]) {
    test(`${file}: rejects ${key} placeholder`, async () => {
      await expectFailure({
        config: { ...credentials, [key]: placeholder },
      }, /replace the setup credential placeholders/, 0);
    });
  }

  for (const body of ['not json', sensitive, '', '{"token":']) {
    test(`${file}: rejects malformed authentication JSON ${JSON.stringify(body)}`, async () => {
      await expectFailure({
        replies: [response(200, body)],
      }, /authentication returned invalid JSON/, 1);
    });
  }

  for (const value of [undefined, null, '', ' ', 'bad\nheader', 123, {}, []]) {
    test(`${file}: rejects invalid token ${JSON.stringify(value)}`, async () => {
      await expectFailure({
        replies: [response(200, JSON.stringify({ token: value }))],
      }, /authentication returned a missing or invalid token/, 1);
    });
    test(`${file}: rejects invalid nested token ${JSON.stringify(value)}`, async () => {
      await expectFailure({
        replies: [response(200, JSON.stringify({ TokenInfo: { Token: value } }))],
      }, /authentication returned a missing or invalid token/, 1);
    });
  }

  test(`${file}: does not replace an invalid nested token with a legacy token`, async () => {
    await expectFailure({
      replies: [response(200, JSON.stringify({ TokenInfo: { Token: '' }, token }))],
    }, /authentication returned a missing or invalid token/, 1);
  });

  for (const body of ['null', '[]', '"a string"', 'true']) {
    test(`${file}: rejects token response shape ${body}`, async () => {
      await expectFailure({
        replies: [response(200, body)],
      }, /authentication returned a missing or invalid token/, 1);
    });
  }

  for (const [index, stage] of stages.entries()) {
    const withStageReply = reply => stageReplies(stage, reply);
    const requestCount = stageUrls(stage);

    for (const status of [301, 400, 401, 403, 429, 500, 503]) {
      test(`${file}: throws on ${stage} HTTP ${status}`, async () => {
        await expectFailure({
          replies: withStageReply(response(status, sensitive)),
        }, new RegExp(`${stage} returned HTTP ${status}`), requestCount);
      });
    }

    for (const reason of ['network failure', 'request-timeout', 'no-redirect']) {
      test(`${file}: sanitizes ${stage} ${reason}; no retry`, async () => {
        await expectFailure({
          replies: withStageReply(new Error(`${reason}: ${sensitive}`)),
        }, new RegExp(`${stage} request failed`), requestCount);
      });
    }

    for (const reason of ['body-timeout', 'max-size', 'connection reset']) {
      test(`${file}: sanitizes ${stage} response ${reason}`, async () => {
        await expectFailure({
          replies: withStageReply({
            ...response(),
            text: async () => { throw new Error(`${reason}: ${sensitive}`); },
          }),
        }, new RegExp(`${stage} response could not be read`), requestCount);
      });
    }

    test(`${file}: releases ${stage} response on HTTP failure`, async () => {
      let destroyed = false;
      const execution = await expectFailure({
        replies: withStageReply({
          ...response(503, sensitive),
          body: { destroy: () => { destroyed = true; } },
          text: async () => {
            if (stage === 'authentication') assert.fail('Must not consume an authentication error body');
            return `{"error":"busy","echo":"${sensitive}"}`;
          },
        }),
      }, new RegExp(`${stage} returned HTTP 503`), requestCount);
      assert.equal(destroyed, true);
      const stageLog = execution.logs[index];
      assert.match(stageLog, new RegExp(`${stage} HTTP 503`));
      if (stage !== 'authentication') assert.match(stageLog, /busy.*\[redacted\]/);
    });

    test(`${file}: logs ${stage} request error code`, async () => {
      const error = Object.assign(new Error(sensitive), { type: 'system', code: 'ECONNRESET' });
      const execution = await expectFailure({
        replies: withStageReply(error),
      }, new RegExp(`${stage} request failed`), requestCount);
      assert.match(execution.logs[index], new RegExp(`${stage} request error type=system code=ECONNRESET`));
    });

    test(`${file}: releases ${stage} response on body failure`, async () => {
      let destroyed = false;
      await expectFailure({
        replies: withStageReply({
          ...response(),
          body: { destroy: () => { destroyed = true; } },
          text: async () => { throw new Error(sensitive); },
        }),
      }, new RegExp(`${stage} response could not be read`), requestCount);
      assert.equal(destroyed, true);
    });
  }

  for (const stage of updateStages) {
    const index = stages.indexOf(stage);
    const withStageReply = reply => stageReplies(stage, reply);
    const requestCount = stageUrls(stage);

    for (const body of ['', ' ', 'OK', '{}', '[]', '[ ]', '{"error":"unknown response contract"}', sensitive]
      .filter(candidate => candidate !== expectedBodies[stage])) {
      test(`${file}: rejects unexpected ${stage} body: ${JSON.stringify(body)}`, async () => {
        const execution = await expectFailure({
          replies: withStageReply(response(200, body)),
        }, new RegExp(`${stage} returned an unexpected response`), requestCount);
        const expectedBody = body.split(credentials.username).join('[redacted]')
          .split(credentials.password).join('[redacted]')
          .split(token).join('[redacted]');
        assert.equal(execution.logs[index],
          `OptiCharge ${startCharging}-${endCharging}: ${stage} HTTP 200, body ${JSON.stringify(expectedBody)}`);
      });
    }

    test(`${file}: truncates long ${stage} response bodies in the log`, async () => {
      const execution = await expectFailure({
        replies: withStageReply(response(200, 'x'.repeat(2000))),
      }, new RegExp(`${stage} returned an unexpected response`), requestCount);
      assert.ok(execution.logs[index].endsWith(`body "${'x'.repeat(500)}..."`));
    });

    for (const status of [201, 202, 204, 206]) {
      test(`${file}: rejects unexpected ${stage} HTTP ${status}`, async () => {
        await expectFailure({
          replies: withStageReply(response(status)),
        }, new RegExp(`${stage} returned an unexpected response`), requestCount);
      });
    }
  }

  for (const body of ['not json', 'null', '[]', '{}', '{"ChargingIntervals":[]}',
    '{"ChargingIntervals":[{"StartCharging":"19:00"}]}', '{"ChargingIntervals":"19:00-07:00"}']) {
    test(`${file}: rejects snapshot ${JSON.stringify(body)} before changing anything`, async () => {
      await expectFailure({
        replies: stageReplies('snapshot', response(200, body)),
      }, /snapshot returned (invalid JSON|settings without valid ChargingIntervals)/, stageUrls('snapshot'));
    });
  }

  for (const stage of followUpStages) {
    test(`${file}: rolls back to the snapshot when ${stage} fails`, async () => {
      const execution = await expectFailure({
        replies: stageReplies(stage, response(500)),
      }, new RegExp(`${stage} returned HTTP 500; rollback to original period 22:00-06:00 accepted \\(HTTP 200\\)`),
      stageUrls(stage));
      const [rollback, rollbackRecalculation] = execution.calls.slice(-2);
      assert.equal(rollback.options.method, 'PUT');
      assert.equal(rollback.options.headers['X-Authorization'], token);
      assert.deepEqual(JSON.parse(rollback.options.body), {
        ItemId: credentials.reporterId,
        Parameters: JSON.stringify(originalSettings),
      });
      assert.equal(rollbackRecalculation.options.method, 'POST');
      assert.deepEqual(JSON.parse(rollbackRecalculation.options.body), {
        ReporterIds: [credentials.reporterId],
      });
    });

    test(`${file}: reports a failed rollback after ${stage} fails`, async () => {
      const replies = stageReplies(stage, response(500));
      replies[replies.length - 2] = response(503);
      await expectFailure({ replies },
        new RegExp(`${stage} returned HTTP 500; rollback to original period 22:00-06:00 failed: rollback returned HTTP 503`),
        stageUrls(stage).slice(0, -1));
    });

    test(`${file}: reports a failed rollback recalculation after ${stage} fails`, async () => {
      const replies = stageReplies(stage, response(500));
      replies[replies.length - 1] = response(200, '');
      await expectFailure({ replies },
        new RegExp(`${stage} returned HTTP 500; rollback to original period 22:00-06:00 failed: rollback recalculation returned an unexpected response`),
        stageUrls(stage));
    });
  }

  function withWindow(start, end) {
    const patched = source
      .replace(`const START_CHARGING = '${startCharging}';`, `const START_CHARGING = '${start}';`)
      .replace(`const END_CHARGING = '${endCharging}';`, `const END_CHARGING = '${end}';`);
    assert.notEqual(patched, source);
    return patched;
  }

  for (const [start, end] of [['19:00', '23:00'], ['22:00', '02:00'], ['00:00', '23:59']]) {
    test(`${file}: accepts charging window ${start}-${end}`, async () => {
      const execution = run({ scriptSource: withWindow(start, end) });
      assert.equal(await execution.completion, true);
      assert.equal(execution.calls.length, 5);
    });
  }

  for (const [start, end, expected] of [
    ['19:00', '22:00', /charging period 3 h 0 min is shorter than WantedHours 4/],
    ['23:00', '02:00', /charging period 3 h 0 min is shorter than WantedHours 4/],
    ['19:00', '22:59', /charging period 3 h 59 min is shorter than WantedHours 4/],
    ['07:00', '07:00', /charging period start and end must differ/],
    ['24:00', '07:00', /invalid charging period time "24:00"/],
    ['19:00', '7:00', /invalid charging period time "7:00"/],
  ]) {
    test(`${file}: rejects charging window ${start}-${end} before any request`, async () => {
      await expectFailure({ scriptSource: withWindow(start, end) }, expected, 0, `${start}-${end}`);
    });
  }
}
