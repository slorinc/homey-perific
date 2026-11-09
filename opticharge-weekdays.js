const START_CHARGING = '19:00';
const END_CHARGING = '07:00';
const WANTED_HOURS = 4;
const config = global.get('enegic.opticharge');

function fail(message) {
  const error = new Error(`OptiCharge ${START_CHARGING}-${END_CHARGING}: ${message}. Actual charging period is unconfirmed.`);
  error.reason = message;
  throw error;
}

if (!config || typeof config !== 'object') {
  fail('missing enegic.opticharge settings');
}

for (const key of ['username', 'password', 'reporterId']) {
  if (typeof config[key] !== 'string' || config[key].trim().length === 0) {
    fail(`missing or invalid ${key} setting`);
  }
}

if (config.username === 'YOUR_USERNAME' || config.password === 'YOUR_PASSWORD') {
  fail('replace the setup credential placeholders');
}

function minutes(time) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (!match) fail(`invalid charging period time ${JSON.stringify(time)}`);
  return Number(match[1]) * 60 + Number(match[2]);
}

const startMinutes = minutes(START_CHARGING);
const endMinutes = minutes(END_CHARGING);
if (endMinutes < startMinutes && startMinutes < 16 * 60) {
  fail('overnight charging period cannot start before 16:00');
}
const windowMinutes = (endMinutes - startMinutes + 1440) % 1440;
if (windowMinutes === 0) {
  fail('charging period start and end must differ');
}
if (windowMinutes < WANTED_HOURS * 60) {
  fail(`charging period ${Math.floor(windowMinutes / 60)} h ${windowMinutes % 60} min is shorter than WantedHours ${WANTED_HOURS}`);
}

let token = null;

function logResponse(stage, detail) {
  log(`OptiCharge ${START_CHARGING}-${END_CHARGING}: ${stage} ${detail}`);
}

function describeBody(text) {
  let safe = text;
  for (const secret of [config.username, config.password, token]) {
    if (secret) safe = safe.split(secret).join('[redacted]');
  }
  return JSON.stringify(safe.length > 500 ? `${safe.slice(0, 500)}...` : safe);
}

async function request(method, path, payload, stage) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['X-Authorization'] = token;
  // Authentication bodies carry the token, so only their status is ever logged.
  const logBody = stage !== 'authentication';

  let response;
  try {
    response = await fetch(`https://api.enegic.com/${path}`, {
      method,
      headers,
      body: JSON.stringify(payload),
      redirect: 'error',
      // node-fetch v2 bounds headers and body separately: up to 10 seconds per call.
      timeout: 5000,
      size: 65536,
    });
  } catch (error) {
    logResponse(stage, `request error type=${error?.type ?? 'unknown'} code=${error?.code ?? 'unknown'}`);
    fail(`${stage} request failed (network, timeout, or redirect); no retry was attempted`);
  }

  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    if (logBody) {
      try {
        detail += `, body ${describeBody(await response.text())}`;
      } catch {
        detail += ', body unreadable';
      }
    }
    if (response.body) response.body.destroy();
    logResponse(stage, detail);
    fail(`${stage} returned HTTP ${response.status}`);
  }

  let body;
  try {
    body = await response.text();
  } catch (error) {
    if (response.body) response.body.destroy();
    logResponse(stage, `HTTP ${response.status}, body read error type=${error?.type ?? 'unknown'} code=${error?.code ?? 'unknown'}`);
    fail(`${stage} response could not be read (network, timeout, or size limit)`);
  }
  logResponse(stage, logBody ? `HTTP ${response.status}, body ${describeBody(body)}` : `HTTP ${response.status}`);
  return { status: response.status, body };
}

const authentication = await request('PUT', 'createtoken', {
  username: config.username,
  password: config.password,
}, 'authentication');

let tokenResponse;
try {
  tokenResponse = JSON.parse(authentication.body);
} catch {
  fail('authentication returned invalid JSON');
}

const parsedToken = tokenResponse?.TokenInfo?.Token ?? tokenResponse?.token;
if (typeof parsedToken !== 'string' || !/^[\x21-\x7e]+$/.test(parsedToken)) {
  fail('authentication returned a missing or invalid token');
}
token = parsedToken;

async function update(method, path, payload, stage, expectedBody = '') {
  const result = await request(method, path, payload, stage);
  if (result.status !== 200 || result.body !== expectedBody) {
    fail(`${stage} returned an unexpected response (expected HTTP 200 with body ${JSON.stringify(expectedBody)})`);
  }
}

const snapshot = await request('PUT', 'getreporterpriceschemasettings/', {
  ItemId: config.reporterId,
}, 'snapshot');

let original;
try {
  original = JSON.parse(snapshot.body);
} catch {
  fail('snapshot returned invalid JSON');
}

const originalIntervals = original?.ChargingIntervals;
if (!Array.isArray(originalIntervals) || originalIntervals.length === 0
  || !originalIntervals.every(i => typeof i?.StartCharging === 'string' && typeof i?.EndCharging === 'string')) {
  fail('snapshot returned settings without valid ChargingIntervals');
}
const originalPeriod = originalIntervals.map(i => `${i.StartCharging}-${i.EndCharging}`).join(', ');

await update('PUT', 'setreporterpriceschemasettings/', {
  ItemId: config.reporterId,
  Parameters: JSON.stringify({
    MaxPrice: -1,
    MinPrice: -1,
    WantedHours: WANTED_HOURS,
    PriceArea: 'SE3',
    ChargingIntervals: [{ StartCharging: START_CHARGING, EndCharging: END_CHARGING }],
    Inverted: false,
    SortDescending: false,
  }),
}, 'period update');

try {
  await update('POST', 'calculatepriceschemas', {
    ReporterIds: [config.reporterId],
  }, 'recalculation', '[]');

  await update('PUT', 'addupdatezaptecreporter', {
    ReporterId: config.reporterId,
    UserSettings: JSON.stringify({ Mode: 'Price', PreviousMode: 'Price' }),
  }, 'mode update');
} catch (error) {
  let outcome;
  try {
    await update('PUT', 'setreporterpriceschemasettings/', {
      ItemId: config.reporterId,
      Parameters: JSON.stringify(original),
    }, 'rollback');
    await update('POST', 'calculatepriceschemas', {
      ReporterIds: [config.reporterId],
    }, 'rollback recalculation', '[]');
    outcome = 'accepted (HTTP 200)';
  } catch (rollbackError) {
    outcome = `failed: ${rollbackError.reason ?? 'unexpected error'}`;
  }
  fail(`${error.reason ?? 'unexpected error'}; rollback to original period ${originalPeriod} ${outcome}`);
}

log(`OptiCharge ${START_CHARGING}-${END_CHARGING}: period update, recalculation and Price mode accepted (HTTP 200); applied schedule is not independently verified.`);
return true;
