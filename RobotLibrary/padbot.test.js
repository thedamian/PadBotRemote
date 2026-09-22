import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as settle } from "node:timers/promises";
import PadBot, { COMMANDS, decodePadBotResponse, normalizeUuid } from "./padbot.js";

// No browser or robot is used. Each write is copied just as a BLE transport would
// consume it; deferred writes let tests exercise the queue without wall-clock waits.
class FakeEventTarget extends EventTarget {
  listeners = new Map();

  addEventListener(type, listener, options) {
    super.addEventListener(type, listener, options);
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }

  removeEventListener(type, listener, options) {
    super.removeEventListener(type, listener, options);
    this.listeners.get(type)?.delete(listener);
  }

  listenerCount(type) { return this.listeners.get(type)?.size ?? 0; }
}

class FakeCharacteristic extends FakeEventTarget {
  constructor(uuid, properties = { writeWithoutResponse: true }, methods = ["without", "with", "legacy"]) {
    super();
    this.uuid = uuid;
    this.properties = properties;
    this.writes = [];
    this.notificationStarts = 0;
    const methodNames = {
      without: "writeValueWithoutResponse",
      with: "writeValueWithResponse",
      legacy: "writeValue",
    };
    for (const method of methods) {
      this[methodNames[method]] = async (value) => {
        const bytes = Uint8Array.from(value);
        const write = { method, bytes, text: new TextDecoder().decode(bytes) };
        this.writes.push(write);
        await this.onWrite?.(write);
      };
    }
  }

  async startNotifications() {
    this.notificationStarts += 1;
    await this.onStartNotifications?.();
    return this;
  }

  notify(value) {
    this.value = value;
    this.dispatchEvent(new Event("characteristicvaluechanged"));
  }
}

class FakeService {
  constructor(characteristics, uuid = 0xfff0) {
    this.uuid = uuid;
    this.characteristics = characteristics;
    this.requestedCharacteristics = [];
    this.discoveryCount = 0;
  }

  async getCharacteristics() {
    this.discoveryCount += 1;
    return this.characteristics;
  }

  async getCharacteristic(uuid) {
    this.requestedCharacteristics.push(uuid);
    const found = this.characteristics.find((item) => item.uuid === uuid);
    if (!found) throw new Error(`Missing characteristic ${uuid}`);
    return found;
  }
}

class FakeGatt {
  connected = false;
  connectCount = 0;
  disconnectCount = 0;
  requestedServices = [];

  constructor(device, service) {
    this.device = device;
    this.service = service;
  }

  async connect() {
    this.connectCount += 1;
    await this.onConnect?.();
    this.connected = true;
    return this;
  }

  async getPrimaryService(uuid) {
    this.requestedServices.push(uuid);
    await this.onGetService?.();
    return this.service;
  }

  disconnect() {
    this.onDisconnect?.();
    this.disconnectCount += 1;
    this.connected = false;
    this.device.dispatchEvent(new Event("gattserverdisconnected"));
  }
}

class FakeDevice extends FakeEventTarget {
  id = "permitted-padbot";
  name = "PadBot Test";

  constructor(service) {
    super();
    this.gatt = new FakeGatt(this, service);
  }
}

class FakeBluetooth extends FakeEventTarget {
  requests = [];
  knownDeviceRequests = 0;

  constructor(device) {
    super();
    this.device = device;
  }

  async requestDevice(options) {
    this.requests.push(options);
    await this.onRequestDevice?.();
    return this.device;
  }

  async getDevices() {
    this.knownDeviceRequests += 1;
    return [this.device];
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function rig(context, options = {}, characteristics = [new FakeCharacteristic(0xfff1)]) {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const service = new FakeService(characteristics);
  const device = new FakeDevice(service);
  const bluetooth = new FakeBluetooth(device);
  const bot = new PadBot({ bluetooth, protocolMode: "raw", initialize: false, ...options });
  const commands = [];
  const errors = [];
  const disconnections = [];
  bot.addEventListener("command", (event) => commands.push(event.detail));
  bot.addEventListener("error", (event) => errors.push(event.detail));
  bot.addEventListener("disconnected", (event) => disconnections.push(event.detail));
  context.after(() => {
    // Simulate a radio loss instead of creating a three-write disconnect task in cleanup.
    if (device.gatt.connected) device.gatt.disconnect();
  });
  return { bot, bluetooth, device, service, characteristics, writer: characteristics[0], commands, errors, disconnections };
}

async function connectedRig(context, options, characteristics) {
  const value = rig(context, options, characteristics);
  await value.bot.connect();
  return value;
}

async function advance(context, milliseconds) {
  context.mock.timers.tick(milliseconds);
  // Let promise-based BLE writes finish before advancing the next timer boundary.
  await settle();
}

function frames(characteristic) { return characteristic.writes.map((write) => write.text); }
function commandNames(value) { return value.commands.map((command) => command.command); }

for (const [protocolMode, expected] of [
  ["raw", [":"]],
  ["mn", ["m:n"]],
  ["pq", ["p:q"]],
  ["auto", [":", "m:n", "p:q"]],
]) {
  test(`${protocolMode} protocol writes the expected frames and command event`, async (context) => {
    const value = await connectedRig(context, { protocolMode });
    const result = await value.bot.queryBattery();
    assert.deepEqual(frames(value.writer), expected);
    assert.equal(result.command, COMMANDS.BATTERY);
    assert.deepEqual(result.writes, expected.map((frame) => ({ frame, characteristicUuid: 0xfff1 })));
    assert.deepEqual(result.failures, []);
    assert.equal(value.commands[0], result);
    assert.equal(value.bot.lastCommand, ":");
  });
}

for (const [method, command] of Object.entries({
  forward: "X1", backward: "X4", left: "X2", right: "X3",
  forwardLeft: "XG", forwardRight: "XK", backwardLeft: "XO", backwardRight: "XS",
  headUp: "X5", headDown: "XA",
})) {
  test(`${method} wrapper sends ${command} without repeats when repeatMs is zero`, async (context) => {
    const value = await connectedRig(context);
    assert.equal((await value.bot[method]({ repeatMs: 0 })).command, command);
    await advance(context, 5000);
    assert.deepEqual(frames(value.writer), [command]);
  });
}

for (const [input, name, command] of [
  ["low", "low", "D"], ["medium", "medium", "E"], ["fast", "fast", "V"], ["faster", "faster", "W"], ["maximum", "maximum", "["], ["top", "top", "]"],
  [1, "low", "D"], [2, "medium", "E"], [3, "fast", "V"], [4, "faster", "W"], [5, "maximum", "["], [6, "top", "]"],
]) {
  test(`speed ${JSON.stringify(input)} maps to ${name} and ${command}`, async (context) => {
    const value = await connectedRig(context);
    await value.bot.setSpeed(input);
    assert.equal(value.bot.speed, name);
    assert.deepEqual(frames(value.writer), [command]);
    assert.equal(new PadBot({ speed: input }).speed, name);
  });
}

test("invalid speed names and numbers reject without writing or changing speed", async (context) => {
  const value = await connectedRig(context);
  for (const speed of [0, 7, -1, 1.5, NaN, Infinity, "1", "LOW", "turbo", "", null, undefined, true]) {
    await assert.rejects(value.bot.setSpeed(speed), RangeError);
    if (speed !== undefined) assert.throws(() => new PadBot({ speed }), RangeError);
  }
  assert.equal(value.bot.speed, "medium");
  assert.deepEqual(frames(value.writer), []);
});

test("constructor rejects array/object speed values rather than coercing them", () => {
  for (const speed of [["low"], new String("medium"), { toString: () => "fast" }]) {
    assert.throws(() => new PadBot({ speed }), RangeError);
  }
});

test("setSpeed rejects array/object speed values rather than coercing them", async (context) => {
  const value = await connectedRig(context);
  for (const speed of [["low"], new String("medium"), { toString: () => "fast" }]) {
    await assert.rejects(value.bot.setSpeed(speed), RangeError);
  }
  assert.deepEqual(frames(value.writer), []);
});

test("UUID normalization accepts short, numeric and full UUIDs and rejects malformed values", () => {
  assert.equal(normalizeUuid(" 0xFFF0 "), 0xfff0);
  assert.equal(normalizeUuid("FFF1"), 0xfff1);
  assert.equal(normalizeUuid(0), 0);
  assert.equal(normalizeUuid(0xffffffff), 0xffffffff);
  assert.equal(normalizeUuid("0000FFF0-0000-1000-8000-00805F9B34FB"), "0000fff0-0000-1000-8000-00805f9b34fb");
  for (const uuid of [null, undefined, {}, -1, 0x100000000, 1.5, "", "fff", "not-a-uuid"]) {
    assert.throws(() => normalizeUuid(uuid), TypeError);
  }
  assert.throws(() => new PadBot({ serviceUuid: "bad" }), TypeError);
  assert.throws(() => new PadBot({ writeUuid: "bad" }), TypeError);
  assert.throws(() => new PadBot({ notifyUuid: "bad" }), TypeError);
  assert.throws(() => new PadBot({ protocolMode: "invalid" }), RangeError);
});

test("invalid directions, durations, repeat delays and commands reject before transport", async (context) => {
  const value = await connectedRig(context);
  for (const direction of ["diagonal", "FORWARD", "", null, undefined, ["forward"], { toString: () => "left" }]) {
    await assert.rejects(value.bot.drive(direction), RangeError);
  }
  for (const delay of [-1, 0.1, Infinity, NaN, "10", null, 2147483648]) {
    await assert.rejects(value.bot.forward({ durationMs: delay, repeatMs: 0 }), RangeError);
    await assert.rejects(value.bot.forward({ repeatMs: delay }), RangeError);
  }
  for (const command of ["", 0, null, undefined, {}, ["X1"]]) {
    await assert.rejects(value.bot.sendCommand(command), TypeError);
  }
  assert.deepEqual(frames(value.writer), []);
  await value.bot.forward({ durationMs: 2147483647, repeatMs: 0 });
  await value.bot.right({ repeatMs: 0 });
  assert.deepEqual(frames(value.writer), ["X1", "X3"]);
});

test("disconnected command methods return rejected promises", async (context) => {
  const { bot } = rig(context);
  for (const invoke of [
    () => bot.forward({ repeatMs: 0 }), () => bot.stop(), () => bot.setSpeed(1),
    () => bot.sendCommand("X1"), () => bot.queryBattery(), () => bot.queryInfrared(),
    () => bot.queryInfo(), () => bot.initializeSpeed(), () => bot.dock(), () => bot.undock(),
  ]) {
    const result = invoke();
    assert.equal(typeof result.then, "function");
    await assert.rejects(result, /not connected/);
  }
});

test("default connect discovers writers and notifications, initializes E, &, ; and : in auto", async (context) => {
  const writer = new FakeCharacteristic(0xfff1);
  const second = new FakeCharacteristic(0xfff2, { write: true });
  const notify = new FakeCharacteristic(0xfff3, { notify: true }, []);
  const ignored = new FakeCharacteristic(0xfff4, { read: true }, []);
  const value = rig(context, { protocolMode: undefined, initialize: undefined }, [writer, second, notify, ignored]);
  let connectionEvent;
  value.bot.addEventListener("connected", (event) => { connectionEvent = event.detail; });
  assert.equal(value.bot.connected, false);
  const info = await value.bot.connect();
  assert.deepEqual(value.bluetooth.requests, [{
    filters: [{ services: [0xfff0] }, { namePrefix: "PadBot" }, { namePrefix: "padbot" }, { namePrefix: "PA6208" }],
    optionalServices: [0xfff0],
  }]);
  assert.deepEqual(value.device.gatt.requestedServices, [0xfff0]);
  assert.equal(value.service.discoveryCount, 1);
  assert.deepEqual(frames(writer), ["E", "mEn", "pEq", "&", "m&n", "p&q", ";", "m;n", "p;q", ":", "m:n", "p:q"]);
  assert.deepEqual(frames(second), frames(writer));
  assert.deepEqual(frames(ignored), []);
  assert.equal(notify.notificationStarts, 1);
  assert.deepEqual(info, {
    connected: true, deviceId: value.device.id, deviceName: value.device.name,
    serviceUuid: 0xfff0, writeUuids: [0xfff1, 0xfff2], notifyUuid: 0xfff3, protocolMode: "auto", hardwareVersion: null, obstacleAvoidance: null,
  });
  assert.deepEqual(connectionEvent, info);
  assert.equal(value.bot.device, value.device);
  assert.equal(value.bot.lastCommand, ":");
});

test("non-auto initialization sends configured speed and infrared but not info", async (context) => {
  const value = await connectedRig(context, { protocolMode: "mn", initialize: true, speed: 3 });
  assert.deepEqual(frames(value.writer), ["mVn", "m&n", "m;n"]);
});

test("SDK notification decoder recognizes PadBot status fields and preserves unknown replies", () => {
  assert.deepEqual(decodePadBotResponse("ver\t1902"), { type: "hardware-version", raw: "ver\t1902", hardwareVersion: 1902, payload: "1902" });
  assert.deepEqual(decodePadBotResponse("rid:PA6208"), { type: "serial-number", raw: "rid:PA6208", serialNumber: "PA6208", payload: "PA6208" });
  assert.deepEqual(decodePadBotResponse("vol=12.3"), { type: "battery-voltage", raw: "vol=12.3", voltage: 12.3, payload: "12.3" });
  assert.deepEqual(decodePadBotResponse("inf 1,2,3,4,5"), { type: "obstacle-distances", raw: "inf 1,2,3,4,5", distances: [1, 2, 3, 4, 5], payload: "1,2,3,4,5" });
  assert.deepEqual(decodePadBotResponse("unexpected"), { type: "unknown", raw: "unexpected" });
});

test("sdk protocol learns the hardware version then uses its single required frame", async (context) => {
  const writer = new FakeCharacteristic(0xfff1);
  const notify = new FakeCharacteristic(0xfff3, { notify: true }, []);
  writer.onWrite = ({ text }) => {
    if (text !== ";") return;
    const bytes = new TextEncoder().encode("ver\t1902");
    notify.notify(new DataView(bytes.buffer));
  };
  const value = rig(context, { protocolMode: "sdk", initialize: true, speed: "top", obstacleAvoidance: false }, [writer, notify]);
  let reportedVersion;
  value.bot.addEventListener("hardwareversion", (event) => { reportedVersion = event.detail.version; });
  await value.bot.connect();
  assert.equal(value.bot.hardwareVersion, 1902);
  assert.equal(reportedVersion, 1902);
  assert.equal(value.bot.obstacleAvoidance, false);
  assert.deepEqual(frames(writer), [";", "p]q", "pZq"]);
  await value.bot.forward({ repeatMs: 0 });
  assert.deepEqual(frames(writer), [";", "p]q", "pZq", "pX1q"]);
  await value.bot.turnOnObstacleDetection();
  assert.equal(value.bot.obstacleAvoidance, true);
  assert.deepEqual(frames(writer), [";", "p]q", "pZq", "pX1q", "pYq"]);
});

test("explicit UUIDs and supplied device select only the requested characteristics", async (context) => {
  const unused = new FakeCharacteristic(0xfff1);
  const writer = new FakeCharacteristic(0xfff2);
  const notify = new FakeCharacteristic(0xfff3, { indicate: true }, []);
  const value = rig(context, { serviceUuid: "0xFFF0", writeUuid: "FFF2", notifyUuid: "0xFFF3" }, [unused, writer, notify]);
  await value.bot.connect({ device: value.device });
  await value.bot.queryInfo();
  assert.equal(value.bluetooth.requests.length, 0);
  assert.deepEqual(value.service.requestedCharacteristics, [0xfff2, 0xfff3]);
  assert.deepEqual(value.bot.connectionInfo.writeUuids, [0xfff2]);
  assert.deepEqual(frames(unused), []);
  assert.deepEqual(frames(writer), [":"]);
  assert.equal(notify.notificationStarts, 1);
});

test("concurrent and repeated connect calls share discovery and initialization", async (context) => {
  const value = rig(context);
  const gate = deferred();
  value.device.gatt.onConnect = () => gate.promise;
  const first = value.bot.connect();
  const second = value.bot.connect();
  assert.equal(first, second);
  gate.resolve();
  await Promise.all([first, second]);
  await value.bot.connect();
  assert.equal(value.bluetooth.requests.length, 1);
  assert.equal(value.device.gatt.connectCount, 1);
});

for (const [label, properties, methods, expected] of [
  ["prefers without-response", { writeWithoutResponse: true, write: true }, ["without", "with", "legacy"], "without"],
  ["uses with-response when advertised", { write: true }, ["without", "with", "legacy"], "with"],
  ["falls back to with-response when without-response method is absent", { writeWithoutResponse: true }, ["with", "legacy"], "with"],
  ["falls back to legacy writeValue", { write: true }, ["legacy"], "legacy"],
]) {
  test(`write API selection ${label}`, async (context) => {
    const writer = new FakeCharacteristic(0xfff1, properties, methods);
    const { bot } = await connectedRig(context, {}, [writer]);
    await bot.queryBattery();
    assert.equal(writer.writes[0].method, expected);
    assert.deepEqual(frames(writer), [":"]);
  });
}

test("partial characteristic failures preserve successful writes across all auto frames", async (context) => {
  const broken = new FakeCharacteristic(0xfff1);
  const healthy = new FakeCharacteristic(0xfff2);
  const failure = new Error("transport refused");
  broken.onWrite = () => { throw failure; };
  const value = await connectedRig(context, { protocolMode: "auto" }, [broken, healthy]);
  const result = await value.bot.queryBattery();
  assert.equal(result.writes.length, 3);
  assert.equal(result.failures.length, 3);
  assert.ok(result.failures.every((item) => item.error === failure && item.characteristicUuid === broken.uuid));
  assert.deepEqual(frames(healthy), [":", "m:n", "p:q"]);
  assert.equal(value.bot.lastCommand, ":");
  assert.deepEqual(value.errors, []);
});

test("partial protocol-frame failure still succeeds on the same characteristic", async (context) => {
  const value = await connectedRig(context, { protocolMode: "auto" });
  value.writer.onWrite = ({ text }) => { if (text !== "m:n") throw new Error("unsupported frame"); };
  const result = await value.bot.queryBattery();
  assert.deepEqual(result.writes, [{ frame: "m:n", characteristicUuid: value.writer.uuid }]);
  assert.equal(result.failures.length, 2);
});

test("total failure rejects AggregateError and queue recovers for the next command", async (context) => {
  const value = await connectedRig(context, { protocolMode: "auto" });
  value.writer.onWrite = ({ text }) => { if (text.includes("D")) throw new Error("failed speed write"); };
  const failed = assert.rejects(value.bot.setSpeed("low"), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors.length, 3);
    assert.match(error.message, /All BLE writes failed/);
    return true;
  });
  const recovered = value.bot.queryBattery();
  await failed;
  assert.equal((await recovered).command, ":");
  assert.equal(value.bot.speed, "medium");
  assert.deepEqual(commandNames(value), [":"]);
  assert.equal(value.bot.lastCommand, ":");
});

test("queue serializes concurrent commands and every target/frame write", async (context) => {
  const first = new FakeCharacteristic(0xfff1);
  const second = new FakeCharacteristic(0xfff2);
  const value = await connectedRig(context, { protocolMode: "auto" }, [first, second]);
  const gate = deferred();
  let active = 0;
  let maximum = 0;
  const order = [];
  for (const characteristic of [first, second]) {
    characteristic.onWrite = async ({ text }) => {
      active += 1;
      maximum = Math.max(maximum, active);
      order.push(`${characteristic.uuid}:${text}`);
      if (order.length === 1) await gate.promise;
      active -= 1;
    };
  }
  const battery = value.bot.queryBattery();
  const infrared = value.bot.queryInfrared();
  const speed = value.bot.setSpeed(3);
  await settle();
  assert.equal(order.length, 1);
  gate.resolve();
  await Promise.all([battery, infrared, speed]);
  assert.equal(maximum, 1);
  assert.deepEqual(order, [":", "m:n", "p:q", "&", "m&n", "p&q", "V", "mVn", "pVq"]
    .flatMap((frame) => [`${first.uuid}:${frame}`, `${second.uuid}:${frame}`]));
});

test("notification bytes respect DataView offsets and are copied before buffer reuse", async (context) => {
  const writer = new FakeCharacteristic(0xfff1);
  const notify = new FakeCharacteristic(0xfff2, { notify: true }, []);
  const value = await connectedRig(context, {}, [writer, notify]);
  const events = [];
  value.bot.addEventListener("notification", (event) => events.push(event.detail));
  const backing = new Uint8Array([0xff, 65, 66, 67, 0xfe]);
  notify.notify(new DataView(backing.buffer, 1, 3));
  backing.fill(0);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].bytes, new Uint8Array([65, 66, 67]));
  assert.equal(events[0].text, "ABC");
  assert.equal(events[0].characteristicUuid, notify.uuid);
  value.device.gatt.disconnect();
  assert.equal(notify.listenerCount("characteristicvaluechanged"), 0);
  notify.notify(new DataView(new ArrayBuffer(0)));
  assert.equal(events.length, 1);
});

test("getKnownDevices never opens chooser and reconnect reuses the previous device", async (context) => {
  const value = rig(context);
  assert.deepEqual(await value.bot.getKnownDevices(), [value.device]);
  assert.equal(value.bluetooth.requests.length, 0);
  await assert.rejects(value.bot.reconnect(), /No previous device/);
  await value.bot.connect();
  value.device.gatt.disconnect();
  assert.equal(value.bot.device, value.device);
  await value.bot.reconnect();
  assert.equal(value.bot.connected, true);
  assert.equal(value.bluetooth.requests.length, 1);
  assert.equal(value.device.gatt.connectCount, 2);
  assert.equal(value.device.listenerCount("gattserverdisconnected"), 1);
});

test("reconnect accepts an explicit permitted device without chooser", async (context) => {
  const value = rig(context);
  await value.bot.reconnect(value.device);
  assert.equal(value.bot.connected, true);
  assert.equal(value.bluetooth.requests.length, 0);
});

test("unavailable Bluetooth, unsupported listing and chooser rejection propagate", async (context) => {
  const bot = new PadBot({ bluetooth: null });
  await assert.rejects(bot.connect(), /Web Bluetooth is unavailable/);
  await assert.rejects(bot.getKnownDevices(), /cannot list/);
  await assert.rejects(new PadBot({ bluetooth: {} }).getKnownDevices(), /cannot list/);
  const value = rig(context);
  const denied = new DOMException("Chooser cancelled", "NotFoundError");
  value.bluetooth.onRequestDevice = () => { throw denied; };
  await assert.rejects(value.bot.connect(), (error) => error === denied);
  assert.equal(value.bot.connected, false);
  value.bluetooth.onRequestDevice = null;
  await value.bot.connect();
  assert.equal(value.bot.connected, true);
});

test("device without a GATT server rejects cleanly", async (context) => {
  const value = rig(context);
  await assert.rejects(value.bot.connect({ device: {} }), /does not provide a GATT/);
  assert.equal(value.bot.connected, false);
  await value.bot.connect();
  assert.equal(value.bot.connected, true);
});

for (const stage of ["connect", "service", "no-writers", "explicit-readonly", "notify", "initialize"]) {
  test(`failed connect cleans listeners and state at ${stage}, then permits retry`, async (context) => {
    const writer = new FakeCharacteristic(0xfff1);
    const notify = new FakeCharacteristic(0xfff2, { notify: true }, []);
    const value = rig(context, {
      initialize: stage === "initialize",
      writeUuid: stage === "explicit-readonly" ? 0xfff2 : null,
    }, [writer, notify]);
    const failure = new Error(`${stage} failed`);
    if (stage === "connect") value.device.gatt.onConnect = () => { throw failure; };
    if (stage === "service") value.device.gatt.onGetService = () => { throw failure; };
    if (stage === "no-writers") writer.properties = { read: true };
    if (stage === "notify") notify.onStartNotifications = () => { throw failure; };
    if (stage === "initialize") writer.onWrite = () => { throw failure; };
    let connectedEvents = 0;
    value.bot.addEventListener("connected", () => connectedEvents++);
    await assert.rejects(value.bot.connect());
    assert.equal(connectedEvents, 0);
    assert.equal(value.bot.connected, false);
    assert.equal(value.device.gatt.connected, false);
    assert.equal(value.device.listenerCount("gattserverdisconnected"), 0);
    assert.equal(notify.listenerCount("characteristicvaluechanged"), 0);
    assert.deepEqual(value.bot.connectionInfo.writeUuids, []);
    assert.equal(value.bot.connectionInfo.serviceUuid, null);
    assert.equal(value.bot.connectionInfo.notifyUuid, null);
    assert.equal(value.bot.lastCommand, null);
    assert.equal(value.device.gatt.disconnectCount, stage === "connect" ? 0 : 1);
    assert.deepEqual(value.disconnections, []);
    value.device.gatt.onConnect = null;
    value.device.gatt.onGetService = null;
    writer.properties = { writeWithoutResponse: true };
    writer.onWrite = null;
    notify.onStartNotifications = null;
    if (stage === "explicit-readonly") notify.properties.write = true;
    await value.bot.reconnect();
    assert.equal(value.bot.connected, true);
    assert.equal(connectedEvents, 1);
  });
}

test("disconnect cancels continuous hold and completes three STOP writes before radio close", async (context) => {
  const value = await connectedRig(context);
  await value.bot.forward({ repeatMs: 50 });
  let framesAtDisconnect;
  value.device.gatt.onDisconnect = () => { framesAtDisconnect = frames(value.writer); };
  const disconnecting = value.bot.disconnect();
  assert.equal(value.bot.disconnect(), disconnecting);
  await settle();
  assert.deepEqual(frames(value.writer), ["X1", "0"]);
  assert.equal(value.device.gatt.connected, true);
  await assert.rejects(value.bot.forward({ repeatMs: 0 }), /Disconnect is in progress/);
  await assert.rejects(value.bot.connect(), /Disconnect is in progress/);
  await advance(context, 90);
  assert.deepEqual(frames(value.writer), ["X1", "0", "0"]);
  assert.equal(value.device.gatt.connected, true);
  await advance(context, 90);
  await disconnecting;
  assert.deepEqual(framesAtDisconnect, ["X1", "0", "0", "0"]);
  assert.equal(value.device.gatt.disconnectCount, 1);
  assert.equal(value.bot.connected, false);
  assert.equal(value.bot.lastCommand, null);
  assert.deepEqual(value.disconnections, [{ device: value.device, unexpected: false }]);
  await advance(context, 1000);
  assert.deepEqual(frames(value.writer), framesAtDisconnect);
  await value.bot.disconnect();
  assert.equal(value.device.gatt.disconnectCount, 1);
});

test("disconnect closes the radio even if every STOP write fails", async (context) => {
  const value = await connectedRig(context);
  value.writer.onWrite = () => { throw new Error("radio write failure"); };
  const rejected = assert.rejects(value.bot.disconnect(), AggregateError);
  await settle();
  await advance(context, 90);
  await advance(context, 90);
  await rejected;
  assert.deepEqual(frames(value.writer), ["0", "0", "0"]);
  assert.equal(value.device.gatt.connected, false);
  assert.equal(value.device.listenerCount("gattserverdisconnected"), 0);
  assert.equal(value.disconnections[0].unexpected, false);
});

test("unexpected disconnect cancels duration and repeat timers and resets state", async (context) => {
  const value = await connectedRig(context);
  await value.bot.forward({ durationMs: 500, repeatMs: 100 });
  value.device.gatt.disconnect();
  await advance(context, 5000);
  assert.deepEqual(frames(value.writer), ["X1"]);
  assert.equal(value.bot.connected, false);
  assert.equal(value.bot.lastCommand, null);
  assert.equal(value.disconnections.length, 1);
  assert.equal(value.disconnections[0].unexpected, true);
  assert.deepEqual(value.errors, []);
});

test("STOP supersedes queued motion behind an in-flight query", async (context) => {
  const value = await connectedRig(context);
  const gate = deferred();
  value.writer.onWrite = ({ text }) => text === ":" ? gate.promise : undefined;
  const battery = value.bot.queryBattery();
  await settle();
  const superseded = assert.rejects(value.bot.forward({ repeatMs: 0 }), { name: "AbortError" });
  const stop = value.bot.stop();
  gate.resolve();
  await Promise.all([battery, superseded, stop]);
  await advance(context, 90);
  await advance(context, 90);
  assert.deepEqual(frames(value.writer), [":", "0", "0", "0"]);
  assert.deepEqual(value.errors, []);
});

test("a new direction supersedes queued motion without issuing stale STOP", async (context) => {
  const value = await connectedRig(context);
  const gate = deferred();
  value.writer.onWrite = ({ text }) => text === ":" ? gate.promise : undefined;
  const battery = value.bot.queryBattery();
  await settle();
  const superseded = assert.rejects(value.bot.forward({ durationMs: 50, repeatMs: 10 }), { name: "AbortError" });
  const right = value.bot.right({ repeatMs: 0 });
  gate.resolve();
  await Promise.all([battery, superseded, right]);
  await advance(context, 5000);
  assert.deepEqual(frames(value.writer), [":", "X3"]);
  assert.deepEqual(value.errors, []);
});

test("in-flight superseded auto motion cannot send remaining frames or schedule stale STOP", async (context) => {
  const value = await connectedRig(context, { protocolMode: "auto" });
  const gate = deferred();
  value.writer.onWrite = ({ text }) => text === "X1" ? gate.promise : undefined;
  const superseded = assert.rejects(value.bot.forward({ durationMs: 50, repeatMs: 10 }), { name: "AbortError" });
  await settle();
  assert.deepEqual(frames(value.writer), ["X1"]);
  const right = value.bot.right({ repeatMs: 0 });
  gate.resolve();
  await Promise.all([superseded, right]);
  await advance(context, 1000);
  assert.deepEqual(frames(value.writer), ["X1", "X3", "mX3n", "pX3q"]);
});

test("new direction cancels prior duration, repeat timers and delayed STOP writes", async (context) => {
  const value = await connectedRig(context);
  await value.bot.forward({ durationMs: 500, repeatMs: 100 });
  await advance(context, 50);
  await value.bot.left({ repeatMs: 0 });
  await advance(context, 1000);
  assert.deepEqual(frames(value.writer), ["X1", "X2"]);
  await value.bot.stop();
  await advance(context, 50);
  await value.bot.right({ repeatMs: 0 });
  await advance(context, 1000);
  assert.deepEqual(frames(value.writer), ["X1", "X2", "0", "X3"]);
});

test("new direction supersedes a queued STOP as well as its retry timers", async (context) => {
  const value = await connectedRig(context);
  const gate = deferred();
  value.writer.onWrite = ({ text }) => text === ":" ? gate.promise : undefined;
  const battery = value.bot.queryBattery();
  await settle();
  const superseded = assert.rejects(value.bot.stop(), { name: "AbortError" });
  const right = value.bot.right({ repeatMs: 0 });
  gate.resolve();
  await Promise.all([battery, superseded, right]);
  await advance(context, 1000);
  assert.deepEqual(frames(value.writer), [":", "X3"]);
});

test("timed driving repeats until duration then sends STOP at 0, 90 and 180 ms", async (context) => {
  const value = await connectedRig(context);
  await value.bot.forward({ durationMs: 250, repeatMs: 100 });
  assert.deepEqual(frames(value.writer), ["X1"]);
  await advance(context, 99);
  assert.deepEqual(frames(value.writer), ["X1"]);
  await advance(context, 1);
  await advance(context, 100);
  assert.deepEqual(frames(value.writer), ["X1", "X1", "X1"]);
  await advance(context, 50);
  assert.deepEqual(frames(value.writer), ["X1", "X1", "X1", "0"]);
  await advance(context, 89);
  assert.equal(value.writer.writes.length, 4);
  await advance(context, 1);
  await advance(context, 90);
  await advance(context, 1000);
  assert.deepEqual(frames(value.writer), ["X1", "X1", "X1", "0", "0", "0"]);
});

test("duration works with repeatMs zero and resolves before the scheduled STOP", async (context) => {
  const value = await connectedRig(context);
  const result = await value.bot.headUp({ durationMs: 200, repeatMs: 0 });
  assert.equal(result.command, "X5");
  await advance(context, 199);
  assert.deepEqual(frames(value.writer), ["X5"]);
  await advance(context, 1);
  assert.deepEqual(frames(value.writer), ["X5", "0"]);
});

test("continuous driving uses default 220 ms repeats until explicitly stopped", async (context) => {
  const value = await connectedRig(context);
  await value.bot.forward();
  await advance(context, 219);
  assert.deepEqual(frames(value.writer), ["X1"]);
  await advance(context, 1);
  await advance(context, 220);
  await advance(context, 220);
  assert.deepEqual(frames(value.writer), ["X1", "X1", "X1", "X1"]);
  await value.bot.stop();
  await advance(context, 90);
  await advance(context, 90);
  await advance(context, 1000);
  assert.deepEqual(frames(value.writer), ["X1", "X1", "X1", "X1", "0", "0", "0"]);
});

test("repeats wait for write completion instead of overlapping a slow transport", async (context) => {
  const value = await connectedRig(context);
  const gate = deferred();
  let motionWrites = 0;
  value.writer.onWrite = ({ text }) => {
    if (text === "X1" && ++motionWrites === 2) return gate.promise;
  };
  await value.bot.forward({ repeatMs: 100 });
  await advance(context, 100);
  await advance(context, 1000);
  assert.deepEqual(frames(value.writer), ["X1", "X1"]);
  gate.resolve();
  await settle();
  await advance(context, 99);
  assert.equal(value.writer.writes.length, 2);
  await advance(context, 1);
  assert.equal(value.writer.writes.length, 3);
});

test("raw command and docking wrappers cancel managed movement", async (context) => {
  const value = await connectedRig(context);
  for (const [invoke, expected] of [
    [() => value.bot.sendCommand("CUSTOM"), "CUSTOM"],
    [() => value.bot.dock(), "<"],
    [() => value.bot.undock(), ">"],
  ]) {
    await value.bot.forward({ durationMs: 300, repeatMs: 50 });
    assert.equal((await invoke()).command, expected);
    const length = value.writer.writes.length;
    await advance(context, 1000);
    assert.equal(value.writer.writes.length, length);
  }
  await value.bot.sendCommand(COMMANDS.STOP);
  await advance(context, 90);
  await advance(context, 90);
  assert.deepEqual(frames(value.writer).slice(-3), ["0", "0", "0"]);
});

test("queries and speed initialization use protocol commands without cancelling a hold", async (context) => {
  const value = await connectedRig(context);
  await value.bot.forward({ repeatMs: 100 });
  await value.bot.queryBattery();
  await value.bot.queryInfrared();
  await value.bot.queryInfo();
  await value.bot.initializeSpeed();
  await value.bot.setSpeed("low");
  await advance(context, 100);
  assert.deepEqual(frames(value.writer), ["X1", ":", "&", ":", "]", "D", "X1"]);
});

test("initial drive failure rejects its promise and attempts safety STOP", async (context) => {
  const value = await connectedRig(context);
  value.writer.onWrite = ({ text }) => { if (text === "X1") throw new Error("motion failed"); };
  await assert.rejects(value.bot.forward({ repeatMs: 0 }), AggregateError);
  await advance(context, 90);
  await advance(context, 90);
  assert.deepEqual(frames(value.writer), ["X1", "0", "0", "0"]);
  assert.deepEqual(value.errors, []);
});

test("asynchronous repeat failures emit error and do not poison subsequent commands", async (context) => {
  const value = await connectedRig(context);
  await value.bot.forward({ repeatMs: 100 });
  value.writer.onWrite = ({ text }) => { if (text === "X1") throw new Error("repeat failed"); };
  await advance(context, 100);
  assert.equal(value.errors.length, 1);
  assert.ok(value.errors[0] instanceof AggregateError);
  assert.match(value.errors[0].errors[0].message, /repeat failed/);
  assert.deepEqual(frames(value.writer), ["X1", "X1", "0"]);
  await advance(context, 90);
  await advance(context, 90);
  assert.deepEqual(frames(value.writer).slice(-3), ["0", "0", "0"]);
  await advance(context, 1000);
  assert.equal(value.writer.writes.length, 5);
  await value.bot.queryBattery();
  assert.equal(value.writer.writes.at(-1).text, ":");
});

test("scheduled STOP failures emit error events, while the initial failure rejects", async (context) => {
  const value = await connectedRig(context);
  value.writer.onWrite = () => { throw new Error("STOP failed"); };
  await assert.rejects(value.bot.stop(), AggregateError);
  assert.deepEqual(value.errors, []);
  await advance(context, 90);
  await advance(context, 90);
  assert.equal(value.errors.length, 2);
  assert.ok(value.errors.every((error) => error instanceof AggregateError));
  assert.deepEqual(frames(value.writer), ["0", "0", "0"]);
});

test("superseded in-flight repeat suppresses AbortError events and stale timers", async (context) => {
  const value = await connectedRig(context);
  await value.bot.forward({ repeatMs: 100 });
  const gate = deferred();
  value.writer.onWrite = ({ text }) => text === "X1" ? gate.promise : undefined;
  await advance(context, 100);
  const right = value.bot.right({ repeatMs: 0 });
  gate.resolve();
  await right;
  await advance(context, 1000);
  assert.deepEqual(frames(value.writer), ["X1", "X1", "X3"]);
  assert.deepEqual(value.errors, []);
});

test("disconnect invalidates queued commands from the old session before reconnect", async (context) => {
  const value = await connectedRig(context);
  const gate = deferred();
  value.writer.onWrite = ({ text }) => text === ":" ? gate.promise : undefined;
  const inflight = assert.rejects(value.bot.queryBattery(), { name: "AbortError" });
  await settle();
  const queued = assert.rejects(value.bot.queryInfo(), { name: "AbortError" });
  value.device.gatt.disconnect();
  await value.bot.reconnect();
  gate.resolve();
  await Promise.all([inflight, queued]);
  await value.bot.queryInfrared();
  assert.deepEqual(frames(value.writer), [":", "&"]);
  assert.deepEqual(commandNames(value), ["&"]);
});
