# Homey charging-period automation

Two standalone HomeyScripts set Perific/Enegic charging periods. Advanced Flow
handles scheduling and personal failure alerts. No custom Homey app or external
server is required.

**Each run sets Perific to Price mode** (`Mode=Price`, `PreviousMode=Price`),
as the Perific webapp does after saving a period.

| HomeyScript | Charging window | Schedule (Homey's local timezone) |
| --- | --- | --- |
| [opticharge-weekend.js](./opticharge-weekend.js) | 16:00 to 15:55 (daily, five-minute gap) | Friday 16:00 |
| [opticharge-weekdays.js](./opticharge-weekdays.js) | 19:00 to 07:00 (overnight) | Monday 07:00 |

These are fixed presets: manual execution applies the script's preset regardless
of the current day. The weekend interval starts at 16:00 because Perific's phone
app rejects an earlier start when the interval extends over midnight.
Each preset remains configured until another update; there is no day-of-week
schedule inside the API payload.

Both scripts also set `MaxPrice=-1`, `MinPrice=-1`, `PriceArea=SE3`,
`Inverted=false`, and `SortDescending=false`. The weekend script sets
`WantedHours=8`; the weekdays script sets `WantedHours=4`.
These values intentionally overwrite the corresponding existing settings.
The interval is a charging window, not a promise of continuous charging:
Perific still governs when charging occurs within the window.

Each preset's window (end minus start, wrapping past midnight) must be at least
`WantedHours` long, and start and end must differ. Times must be `HH:MM`.
Otherwise the script fails before making any API call.

## 1. Configure credentials once

Existing saved configuration needs no changes. For a new setup, open
[HomeyScript](https://my.homey.app/script) on your own Homey Pro and run this
snippet in a temporary setup script. Replace placeholders locally, never in chat
or a shared project copy. Confirm the reporter ID belongs to your charger.

```js
global.set('enegic.opticharge', {
  username: 'YOUR_USERNAME',
  password: 'YOUR_PASSWORD',
   reporterId: 'YOUR_REPORTER_ID',
});
log('OptiCharge settings saved.');
return true;
```

Use JavaScript string escaping for any quotes or backslashes in credentials.
Remove the credential literals from the setup source afterward, or delete that
temporary script.

These settings persist in HomeyScript's app settings and are shared between
scripts. They are **not a secrets vault**: other HomeyScripts can read them and
users with script access must be trusted. Deleting the setup script does not
erase stored settings or backups. Avoid Logic variables, Flow tags, or logging
credentials/tokens. To clear this configuration intentionally:

```js
global.set('enegic.opticharge', null);
return true;
```

Clearing it makes both scripts fail before making any API call.

## 2. Install or replace both scripts

Paste the contents of [opticharge-weekend.js](./opticharge-weekend.js) and
[opticharge-weekdays.js](./opticharge-weekdays.js) into the corresponding saved
HomeyScripts. Update existing saved scripts rather than deleting/recreating
them, to preserve Flow selections, and update their names to match the new
weekend/weekday roles. They contain HomeyScript top-level `await`/`return` and
are not ordinary Node programs.

Each successful run makes exactly five requests, mirroring the Perific webapp:

1. `PUT /createtoken` with username/password; read `TokenInfo.Token`
   (case-sensitive), with support for the original example's top-level `token`.
2. `PUT /getreporterpriceschemasettings/` with `{"ItemId":"<reporterId>"}` to
   snapshot the current settings. The response must be JSON with a non-empty
   `ChargingIntervals` array, or the script fails before changing anything.
3. `PUT /setreporterpriceschemasettings/` with `X-Authorization`, the configured
   reporter ID in `ItemId`, and a JSON **string** in `Parameters`.
4. `POST /calculatepriceschemas` with `{"ReporterIds":["<reporterId>"]}`, which
   recalculates the charging times for the new period.
5. `PUT /addupdatezaptecreporter` with `ReporterId` and a JSON **string** in
   `UserSettings`: `{"Mode":"Price","PreviousMode":"Price"}`.

If call 4 or 5 fails, the script rolls back: it re-sends the complete snapshot
from call 2 to `setreporterpriceschemasettings/`, then calls
`calculatepriceschemas` again. The error then reports the original failure and
whether the rollback was accepted. Mode is not rolled back. A failure of call 3
itself does not trigger a rollback. There are no retries.

The token remains local to that invocation.

The user-observed success for calls 3 and 5 is **HTTP 200 with an empty body**;
for call 4 (recalculation) it is **HTTP 200 with body `[]`**.
The scripts accept those exact responses without JSON parsing. Other bodies
(including whitespace) or other successful statuses are treated as unexpected
and throw a sanitized error naming the stage rather than guessing their meaning.
Acceptance is logged, but does not independently confirm the applied settings.

The scripts use HomeyScript's injected **node-fetch v2**, with a 5-second
request/header timeout and separate 5-second body timeout, and a 64 KiB response
limit. That budgets approximately 10 seconds per call, 50 seconds for a normal
run and 70 seconds with a rollback, excluding overhead. Redirects are rejected.

Each request logs one line with its HTTP status. For every call except
authentication (including HTTP errors) the response body is logged too, truncated to 500 characters, with the
username, password and token replaced by `[redacted]`. The authentication body
is never logged because it contains the token. Network failures log only the
node-fetch `type`/`code`. Underlying exception messages are never logged or
included in errors.

## 3. Wire Advanced Flow

Keep the existing schedules, using two Advanced Flows or independent canvas paths:

### Friday: weekend charging period

1. **When:** Date & Time -> the time is **16:00**.
2. **And:** Date & Time -> the day is **Friday**.
3. From **Yes**, add **Then:** HomeyScript -> **Run Script** -> the weekend script.
4. Connect the script card's **error output**, not normal completion, to
   **Then:** Notifications -> **Send a push notification**.
5. Select **your own Homey user**, not every user. Suggested message:
   `Charging: could not confirm the weekend period 16:00-15:55. Check Perific.`

### Monday: weekday charging period

Repeat with **07:00**, **Monday**, and the weekdays script. Suggested error message:
`Charging: could not confirm the weekday period 19:00-07:00. Check Perific.`

Update old mode-related notification text. If your error branch provides an
error-message tag, append it for sanitized stage/HTTP details. Fixed text works
without it. Exact card labels vary with Homey version/language.

Scripts throw on failure, rather than swallowing errors or returning `false`.
They do not send pushes themselves: **running in the script editor does not test
the Flow notification path**.

Check Homey's timezone and phone notification permissions. There is no startup
catch-up or periodic enforcement: an offline Homey can miss a scheduled change.

## 4. Commission on Homey

1. Keep scheduled paths disabled/disconnected during setup.
2. Run each script at an appropriate time. Inspect the interval, all supplied
   price settings, and the recalculated charging times in Perific; verify mode
   is Price.
3. Confirm the update calls return the expected responses. If one returns another
   shape, obtain a sanitized example before changing the validation; never log
   tokens or authorization headers.
4. Test both notification branches safely: temporarily save a blank `reporterId`
   while preserving the other settings, then run each **Flow path** so it reaches
   its script. Each must fail before any API call and send a push only to you.
   Use a temporary Start path if the day condition blocks the test.
5. Restore the correct configuration and remove any temporary setup credential
   source. If needed, restart HomeyScript and verify settings remain accessible
   without printing them.
6. Check time/day conditions without causing unintended live settings changes.
   Apply the desired current preset, remove temporary Start paths, and enable
   the scheduled paths only after verification.

A failure or timeout may happen after Enegic applied a change. The actual period
is then unconfirmed; inspect it in Perific. Rollback only covers failed
follow-up calls and is itself unverified.
Push delivery is best effort: internet/cloud outages, a stopped Homey, and phone
permissions can prevent delivery. This is not a safety interlock.

## Offline validation

With Node.js 18 or newer, from this folder:

```powershell
node --test .\tests\opticharge.test.cjs
```

Tests execute actual script sources with mocked HomeyScript globals. They check
exact requests, methods, order and presets, the charging-window guard, snapshot
validation, rollback, response validation, error propagation, bounds, and
secret redaction. They never contact
Enegic. Simulated failures do not verify real timeout timing, Homey persistence,
Flow execution, push delivery, or applied device settings.

## API documentation

The scripts use `https://api.enegic.com` and make these five calls in order.
The examples use POSIX shell line continuations; on Windows, use equivalent
PowerShell quoting. Replace placeholders only in private tooling. Never publish
credentials or authorization tokens.

### 1. Create an authentication token

`PUT /createtoken` has no authorization header. The request body contains the
Enegic username and password:

```sh
curl -X PUT \
   'https://api.enegic.com/createtoken' \
   -H 'Content-Type: application/json' \
   --data-raw '{"username":"YOUR_USERNAME","password":"YOUR_PASSWORD"}'
```

The script accepts a token at `TokenInfo.Token` or, for the original response
shape, at the top-level `token`. It does not log the authentication response or
persist the token; the token is sent as `X-Authorization` on calls 2 through 5.

### 2. Read current price-schema settings

`PUT /getreporterpriceschemasettings/` takes the reporter ID in `ItemId`:

```sh
curl -X PUT \
   'https://api.enegic.com/getreporterpriceschemasettings/' \
   -H 'Content-Type: application/json' \
   -H 'X-Authorization: YOUR_TOKEN' \
   --data-raw '{"ItemId":"YOUR_REPORTER_ID"}'
```

The response must be JSON with a non-empty `ChargingIntervals` array. The
script snapshots the complete response so it can restore it if a later call
fails. User-observed HTTP 200 response:

```json
{
   "MaxPrice": -1.0,
   "MinPrice": -1.0,
   "WantedHours": 4,
   "PriceArea": "SE3",
   "ChargingIntervals": [
      { "StartCharging": "19:00", "EndCharging": "07:00" }
   ],
   "Inverted": false,
   "SortDescending": false
}
```

### 3. Set price-schema settings

`PUT /setreporterpriceschemasettings/` takes the reporter ID in `ItemId` and
the settings as a JSON **string** in `Parameters` (not as a nested object):

```sh
curl -X PUT \
   'https://api.enegic.com/setreporterpriceschemasettings/' \
   -H 'Content-Type: application/json' \
   -H 'X-Authorization: YOUR_TOKEN' \
   --data-raw '{
      "ItemId":"YOUR_REPORTER_ID",
      "Parameters":"{\"MaxPrice\":-1,\"MinPrice\":-1,\"WantedHours\":4,\"PriceArea\":\"SE3\",\"ChargingIntervals\":[{\"StartCharging\":\"19:00\",\"EndCharging\":\"07:00\"}],\"Inverted\":false,\"SortDescending\":false}"
   }'
```

The weekend script uses `16:00` to `15:55` and `WantedHours=8` instead.
User-observed success is HTTP 200 with an empty body; the scripts require that
exact response.

### 4. Recalculate the price schema

`POST /calculatepriceschemas` recalculates charging times for the reporter:

```sh
curl -X POST \
   'https://api.enegic.com/calculatepriceschemas' \
   -H 'Content-Type: application/json' \
   -H 'X-Authorization: YOUR_TOKEN' \
   --data-raw '{"ReporterIds":["YOUR_REPORTER_ID"]}'
```

User-observed success is HTTP 200 with body `[]`; the scripts require that
exact response.

### 5. Set reporter mode

`PUT /addupdatezaptecreporter` changes the reporter's mode. The scripts send
`UserSettings` as a JSON **string**:

```sh
curl -X PUT \
   'https://api.enegic.com/addupdatezaptecreporter' \
   -H 'Content-Type: application/json' \
   -H 'X-Authorization: YOUR_TOKEN' \
   --data-raw '{
      "ReporterId":"YOUR_REPORTER_ID",
      "UserSettings":"{\"Mode\":\"Price\",\"PreviousMode\":\"Price\"}"
   }'
```

User-observed success is HTTP 200 with an empty body. The mode endpoint's
response contract and the meaning/necessity of `PreviousMode` are unverified;
do not assume HTTP 200 proves the mode changed. Do not copy browser-specific
headers into HomeyScript.

### Rollback behavior

If call 4 or 5 fails, the script sends the complete snapshot from call 2 back
through call 3, then calls endpoint 4 again. Rollback acceptance is also checked
against the observed HTTP 200/empty-body and HTTP 200/`[]` responses. Mode is
not rolled back. A failure can occur after Enegic has applied a change, so the
actual settings remain unconfirmed until inspected in Perific. There are no
retries.

## Research sources

- [Official HomeyScript app and Flow cards](https://homey.app/en-us/app/com.athom.homeyscript/HomeyScript/)
- [HomeyScript globals and cross-script settings](https://github.com/athombv/com.athom.homeyscript/blob/master/docs/api.js)
- [HomeyScript runtime and persistent settings](https://github.com/athombv/com.athom.homeyscript/blob/master/app.js)
- [HomeyScript node-fetch v2 dependency](https://github.com/athombv/com.athom.homeyscript/blob/master/package.json)
- [Run Script error propagation](https://github.com/athombv/com.athom.homeyscript/blob/master/lib/flow/actions/RunAction.js)
- [Advanced Flow error paths](https://homey.app/en-us/features/advanced-flow/)
- [Native push notification Flow example](https://support.homey.app/hc/en-us/articles/18292876827548-Trigger-Flows-with-Webhooks)

The Enegic request and response contracts above are based on research of the
Perific web app and observed responses; they are not independently verified
against public API documentation.
