# PadBot JavaScript library

Dependency-free browser ES module for connecting to and driving PadBot-compatible BLE robots. 

Usage is simply. Start a website with this code (no compilation or node required) in fact. I'll give you one: [https://thedamian.github.io/PadBotRemote](https://thedamian.github.io/PadBotRemote)

## LOOK OUT FOR:
if the robot seems to only go slowly and turn left and right just fine but not forward. turn "Obsticle avoidance off"


### Command map

| API | Wire token | Meaning |
| --- | --- | --- |
| `forward()` / `backward()` | `X1` / `X4` | Forward / backward |
| `left()` / `right()` | `X2` / `X3` | Turn left / right |
| `forwardLeft()` / `forwardRight()` | `XG` / `XK` | Forward diagonals |
| `backwardLeft()` / `backwardRight()` | `XO` / `XS` | Backward diagonals |
| `headUp()` / `headDown()` | `X5` / `XA` | Head movement |
| `stop()` | `0` | Stop |
| `setSpeed("low")` or `setSpeed(1)` | `D` | Low |
| `setSpeed("medium")` or `setSpeed(2)` | `E` | Medium |
| `setSpeed("fast")` or `setSpeed(3)` | `V` | Third/fast speed |
| `setSpeed("top")` or `setSpeed(6)` | `]` | Sixth/top speed |
| `queryBattery()` | `:` | Request battery/charge data |
| `queryInfrared()` | `&` | Request obstacle/infrared data |
| `queryInfo()` | `:` | Request battery/charge data |
| `queryHardwareVersion()` | `;` | Request hardware version and establish the firmware command framing |
| `dock()` / `undock()` | `<` / `>` | Begin / end auto charge (ending charge does not promise physical backing away) |

Mappings derive from the existing app and its PA6208 testing notes; support and physical behavior vary by model/firmware. No calibrated distance, turn angle, motor PWM, or battery percentage decoding is claimed.

## Constructor options

`new PadBot(options)` accepts:

| Option | Default | Purpose |
| --- | --- | --- |
| `serviceUuid` | `"0xfff0"` | BLE primary service |
| `writeUuid` | `null` | Explicit write characteristic, otherwise all writable characteristics |
| `notifyUuid` | `null` | Explicit notification characteristic, otherwise first notify/indicate characteristic; none is OK |
| `protocolMode` | `"auto"` | `"sdk"` (recommended), `"raw"`, `"mn"`, `"pq"`, or `"auto"` |
| `speed` | `"medium"` | `"low"`, `"medium"`, `"fast"`, `"faster"`, `"maximum"`, `"top"` or numeric `1`–`6` |
| `initialize` | `true` | Send initialization commands on each connection |
| `bluetooth` | `navigator.bluetooth` | Optional injected Web Bluetooth implementation (useful for tests) |

UUIDs accept unsigned numeric IDs, four-digit hexadecimal strings with optional `0x`, or full UUID strings. Empty optional characteristic UUIDs mean discovery. Configuration is fixed per instance. Constructor configuration errors throw synchronously.

## Connection and state APIs

- `await robot.connect()` — pair, discover, subscribe to notifications, and initialize; resolves to `connectionInfo`. Concurrent calls share one connection attempt. Calling when already connected does not select a different device.
- `await robot.connect({ device })` — use an explicitly supplied, previously permitted `BluetoothDevice`, skipping the chooser.
- `await robot.getKnownDevices()` — return devices previously permitted for this origin; never opens the chooser or selects one automatically. Rejects when the browser lacks `getDevices()` support.
- `await robot.reconnect(device?)` — use the supplied device, or the last device selected by this instance. Rejects if neither exists. Retaining the device does not guarantee a successful reconnect; no background reconnect loop runs.
- `await robot.disconnect()` — cancel movement refreshes, attempt three stop writes 90 ms apart, then close GATT even if a stop write fails. Rejects on a stop write failure. It waits for an outstanding connection attempt; it cannot dismiss the browser's chooser. Concurrent disconnect calls share one operation. New public commands are rejected while disconnecting.
- `robot.connected`, `robot.device`, `robot.speed`, `robot.hardwareVersion`, `robot.lastCommand` — read-only accessors. `speed` is the last successfully written selection (or constructor default), not measured speed. `lastCommand` resets on disconnect.
- `robot.connectionInfo` — snapshot with `connected`, `deviceId`, `deviceName`, `serviceUuid`, `writeUuids`, `notifyUuid`, `protocolMode`, and `hardwareVersion`.

## Driving and speed APIs

`await robot.drive(direction, options)` accepts direction names matching the ten movement/head methods in the command table: for example `"forward"`, `"backwardLeft"`, or `"headUp"`. Each convenience method accepts the same options:

| Option | Default | Behavior |
| --- | --- | --- |
| `durationMs` | `0` | Positive duration schedules a stop after the first successful command write. `0` means no automatic stop. |
| `repeatMs` | `220` | Refresh interval after each completed write. `0` sends only once. |

Both timing values must be integer milliseconds from 0 to 2147483647. A drive call **resolves after the initial write**, not at the end of its duration. A new direction, `stop()`, raw command, or disconnect cancels old movement timers and invalidates queued motion commands. Continuous movement must be explicitly stopped. The raw one-shot mode may still leave motors running: never assume one write means one physical step.

`await robot.setSpeed(value)` changes the speed separately, including during a continuous hold, without cancelling movement. The original SDK exposes six discrete levels (`D`, `E`, `V`, `W`, `[`, `]`); there is no percentage-speed API.

`await robot.stop()` cancels motion and sends stop, with two best-effort retries scheduled at 90 and 180 ms. It resolves after the first write. A subsequent movement intentionally cancels delayed stop retries so they cannot stop the new movement. All writes are serialized: a stop cannot preempt a BLE write already in flight, and awaits earlier non-motion operations in the queue.

`await robot.sendCommand(command)` is an advanced escape hatch for a non-empty raw command string, framed according to configuration. It cancels managed movement/retry timers but **does not prepend a stop**. Use `stop()` first if the new command may not halt motion. `sendCommand("0")` uses the full stop behavior. `dock()` and `undock()` use this escape hatch; they cancel managed holds and run only when explicitly requested.

## Results, notifications, and errors

Command promises resolve to `{ command, writes, failures }`. Each successful write contains `{ frame, characteristicUuid }`; each failure adds `error`. As in the app, at least one successful write counts as success, even if other frames/characteristics fail. All writes failing produces `AggregateError`. A successful write is **not** proof that the firmware understood or physically executed the command.

`queryBattery()`, `queryInfrared()`, and `queryInfo()` resolve when written; they do not await, correlate, or parse replies. Observe raw `notification` events instead. No response parser is present in the source app, so this library does not invent one.

Use standard `robot.addEventListener(type, handler)` and `removeEventListener`. Event data is in `event.detail`:

| Event | Detail |
| --- | --- |
| `connected` | Connection-info snapshot after initialization |
| `disconnected` | `{ device, unexpected }`; unexpected radio loss cancels all managed timers |
| `command` | The command write result, including partial failures |
| `notification` | `{ bytes, text, characteristicUuid }`; bytes are copied and respect DataView offsets |
| `hardwareversion` | `{ version }`; emitted after the SDK `ver` response is parsed |
| `error` | Error from a background repeat or scheduled stop; subscribe to avoid silently missing timer failures |

Direct API failures reject promises. Superseded queued/in-flight managed commands reject with `name === "AbortError"`; this is expected when releasing a hold before its first write completes. Catch promises in UI handlers. A failed initial or repeated drive attempts a best-effort stop. Repeated-command cancellation does not emit a background error.

**Safety limit:** timers can be delayed by browser throttling, suspended pages, or slow BLE operations. A closed tab, crashed browser, or lost radio cannot reliably send stop. This is not a hardware emergency-stop system. Add pointer-up, pointer-cancel, blur, and visibility handlers in your host UI that call `stop()` while connected; do not depend on page-unload code to complete asynchronous writes.

## Tests

Use Node.js 22 or newer. From the repository root run `node --test RobotPart/RobotLibrary/padbot.test.js`, or run `npm test` inside `RobotPart/RobotLibrary`. Tests use Node's built-in runner, mocked Bluetooth devices, and fake timers; no installation, browser, or real robot is needed. Keep the repository-relative shared runtime when using the re-export. Hardware behavior must still be checked on your specific robot.
