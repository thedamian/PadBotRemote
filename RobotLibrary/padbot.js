/** Browser-ready PadBot BLE controller. Local so the Remote also works when served as site root. */
// Decompiled from the original PadBot 3.1 Android SDK bundled in ../PadBot-SDK.
export const COMMANDS = Object.freeze({ STOP: "0", FORWARD: "X1", BACKWARD: "X4", LEFT: "X2", RIGHT: "X3", FORWARD_LEFT: "XG", FORWARD_RIGHT: "XK", BACKWARD_LEFT: "XO", BACKWARD_RIGHT: "XS", HEAD_UP: "X5", HEAD_DOWN: "XA", SPEED_LOW: "D", SPEED_MEDIUM: "E", SPEED_FAST: "V", SPEED_FASTER: "W", SPEED_MAXIMUM: "[", SPEED_TOP: "]", SPEED_SETUP: "]", BATTERY: ":", INFRARED: "&", INFO: ":", HARDWARE: ";", DOCK: "<", UNDOCK: ">" });
const DIRECTIONS = Object.freeze({ forward: "X1", backward: "X4", left: "X2", right: "X3", forwardLeft: "XG", forwardRight: "XK", backwardLeft: "XO", backwardRight: "XS", headUp: "X5", headDown: "XA" });
const SPEEDS = Object.freeze({ low: "D", medium: "E", fast: "V", faster: "W", maximum: "[", top: "]" });
const MAX_DELAY = 2147483647;

export function normalizeUuid(value) {
  if (Number.isInteger(value) && value >= 0 && value <= 0xffffffff) return value;
  if (typeof value !== "string") throw new TypeError("UUID must be a string or unsigned integer.");
  const uuid = value.trim().toLowerCase();
  if (/^(?:0x)?[0-9a-f]{4}$/.test(uuid)) return Number.parseInt(uuid.replace(/^0x/, ""), 16);
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(uuid)) return uuid;
  throw new TypeError(`Invalid Bluetooth UUID: ${value}`);
}
/** Decode the named response fields handled by the original PadBot Android SDK. */
export function decodePadBotResponse(value) {
  const raw = String(value ?? "").replace(/\0/g, "").trim();
  const match = /^(ver|rid|vol|inf|vel|hac|hds|flo|mic|wak|msg)\b[\t ,:=]*(.*)$/i.exec(raw);
  if (!match) return { type: "unknown", raw };
  const field = match[1].toLowerCase();
  const payload = match[2].trim();
  const numericList = payload.split(",").map((item) => Number(item.trim()));
  switch (field) {
    case "ver": return { type: "hardware-version", raw, hardwareVersion: Number.parseInt(payload, 10), payload };
    case "rid": return { type: "serial-number", raw, serialNumber: payload.slice(0, 6), payload };
    case "vol": return { type: "battery-voltage", raw, voltage: Number(payload), payload };
    case "inf": return { type: "obstacle-distances", raw, distances: numericList.every(Number.isFinite) ? numericList : null, payload };
    case "vel": return { type: "wheel-speeds", raw, speeds: numericList.every(Number.isFinite) ? numericList : null, payload };
    default: return { type: field, raw, payload };
  }
}
function speedName(value) { const name = typeof value === "number" ? ({ 1: "low", 2: "medium", 3: "fast", 4: "faster", 5: "maximum", 6: "top" })[value] : value; if (typeof name !== "string" || !Object.hasOwn(SPEEDS, name)) throw new RangeError("Speed must be low, medium, fast, faster, maximum, top, or 1 through 6."); return name; }
function delayValue(value, name) { if (!Number.isInteger(value) || value < 0 || value > MAX_DELAY) throw new RangeError(`${name} must be an integer between 0 and ${MAX_DELAY} milliseconds.`); return value; }
function aborted() { return new DOMException("Command superseded or connection closed.", "AbortError"); }

export class PadBot extends EventTarget {
  #bluetooth; #options; #device = null; #server = null; #service = null; #targets = []; #notify = null; #ready = false; #connecting = null; #disconnecting = null; #queue = Promise.resolve(); #session = 0; #motion = 0; #timers = new Set(); #speed; #lastCommand = null; #hardwareVersion = null; #hardwareWaiters = new Set();
  constructor({ bluetooth = globalThis.navigator?.bluetooth, serviceUuid = "0xfff0", writeUuid = null, notifyUuid = null, protocolMode = "auto", speed = "medium", initialize = true } = {}) {
    super();
    if (!["raw", "mn", "pq", "auto", "sdk"].includes(protocolMode)) throw new RangeError("protocolMode must be raw, mn, pq, auto, or sdk.");
    this.#bluetooth = bluetooth; this.#speed = speedName(speed);
    this.#options = { serviceUuid: normalizeUuid(serviceUuid), writeUuid: writeUuid == null || writeUuid === "" ? null : normalizeUuid(writeUuid), notifyUuid: notifyUuid == null || notifyUuid === "" ? null : normalizeUuid(notifyUuid), protocolMode, initialize };
  }
  static isSupported() { return Boolean(globalThis.navigator?.bluetooth); }
  get connected() { return this.#ready && Boolean(this.#server?.connected); }
  get device() { return this.#device; }
  get speed() { return this.#speed; }
  get hardwareVersion() { return this.#hardwareVersion; }
  get lastCommand() { return this.#lastCommand; }
  get connectionInfo() { return { connected: this.connected, deviceId: this.#device?.id ?? null, deviceName: this.#device?.name ?? null, serviceUuid: this.#service?.uuid ?? null, writeUuids: this.#targets.map((item) => item.uuid), notifyUuid: this.#notify?.uuid ?? null, protocolMode: this.#options.protocolMode, hardwareVersion: this.#hardwareVersion }; }
  #emit(type, detail) { const event = new Event(type); Object.defineProperty(event, "detail", { value: detail }); this.dispatchEvent(event); }
  connect({ device } = {}) { if (this.#disconnecting) return Promise.reject(new Error("Disconnect is in progress.")); if (this.#connecting) return this.#connecting; if (this.connected) return Promise.resolve(this.connectionInfo); this.#connecting = this.#connect(device).finally(() => { this.#connecting = null; }); return this.#connecting; }
  async #connect(device) {
    const { serviceUuid, writeUuid, notifyUuid, initialize } = this.#options;
    try {
      if (!device) { if (!this.#bluetooth) throw new Error("Web Bluetooth is unavailable. Use Chrome/Edge on HTTPS or localhost."); device = await this.#bluetooth.requestDevice({ filters: [{ services: [serviceUuid] }, { namePrefix: "PadBot" }, { namePrefix: "padbot" }, { namePrefix: "PA6208" }], optionalServices: [serviceUuid] }); }
      if (!device?.gatt) throw new Error("The selected device does not provide a GATT server.");
      this.#device = device; const session = ++this.#session; const checkSession = () => { if (session !== this.#session) throw aborted(); };
      device.addEventListener("gattserverdisconnected", this.#onDisconnected); this.#server = await device.gatt.connect(); checkSession(); this.#service = await this.#server.getPrimaryService(serviceUuid); checkSession();
      const characteristics = await this.#service.getCharacteristics(); checkSession(); this.#targets = writeUuid !== null ? [await this.#service.getCharacteristic(writeUuid)] : characteristics.filter((item) => item.properties.writeWithoutResponse || item.properties.write); checkSession();
      if (!this.#targets.length || this.#targets.some((item) => !item.properties.writeWithoutResponse && !item.properties.write)) throw new Error("No writable BLE characteristic was found.");
      this.#notify = notifyUuid !== null ? await this.#service.getCharacteristic(notifyUuid) : characteristics.find((item) => item.properties.notify || item.properties.indicate) ?? null; checkSession();
      if (this.#notify) { this.#notify.addEventListener("characteristicvaluechanged", this.#onNotification); await this.#notify.startNotifications(); checkSession(); }
      this.#ready = true;
      if (initialize) {
        // The original SDK sends a raw ';' and waits for `ver` before issuing movement commands.
        if (this.#options.protocolMode === "sdk") {
          await this.queryHardwareVersion({ waitMs: 1500 });
          await this.setSpeed(this.#speed);
          await this.queryInfrared();
        } else {
          await this.setSpeed(this.#speed);
          await this.queryInfrared();
          await this.queryHardwareVersion();
          if (this.#options.protocolMode === "auto") await this.queryInfo();
        }
      }
      checkSession(); this.#emit("connected", this.connectionInfo); return this.connectionInfo;
    } catch (error) { const gatt = this.#device?.gatt; this.#cleanup(); if (gatt?.connected) gatt.disconnect(); throw error; }
  }
  async getKnownDevices() { if (!this.#bluetooth?.getDevices) throw new Error("This browser cannot list previously permitted Bluetooth devices."); return this.#bluetooth.getDevices(); }
  reconnect(device = this.#device) { return device ? this.connect({ device }) : Promise.reject(new Error("No previous device. Call connect() first or supply a permitted device.")); }
  disconnect() { if (!this.#disconnecting) this.#disconnecting = this.#disconnect().finally(() => { this.#disconnecting = null; }); return this.#disconnecting; }
  async #disconnect() { if (this.#connecting) await this.#connecting.catch(() => {}); let failure; try { if (this.connected) { const token = this.#cancelMotion(); for (let index = 0; index < 3; index += 1) { try { await this.#send(COMMANDS.STOP, token); } catch (error) { failure ??= error; } if (index < 2) await new Promise((resolve) => setTimeout(resolve, 90)); } } } finally { const gatt = this.#device?.gatt; const wasReady = this.#ready; this.#cleanup(); if (gatt?.connected) gatt.disconnect(); if (wasReady) this.#emit("disconnected", { device: this.#device, unexpected: false }); } if (failure) throw failure; }
  #onDisconnected = () => { this.#cleanup(); this.#emit("disconnected", { device: this.#device, unexpected: true }); };
  #onNotification = (event) => { const value = event.target.value; const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice(); const text = new TextDecoder().decode(bytes); const decoded = decodePadBotResponse(text); this.#recordHardwareVersion(decoded); this.#emit("notification", { bytes, text, decoded, characteristicUuid: event.target.uuid }); };
  #recordHardwareVersion(text) {
    // SDK callback parses the `ver` field as an integer. Be tolerant of tab, colon, or newline separators.
    const match = Number.isInteger(text?.hardwareVersion) ? [null, String(text.hardwareVersion)] : /(?:^|[^a-z])ver[^0-9]*([12][0-9]{3})(?:\D|$)/i.exec(text?.raw ?? "") ?? /^([12][0-9]{3})$/.exec((text?.raw ?? "").trim());
    if (!match) return;
    const version = Number.parseInt(match[1], 10);
    this.#hardwareVersion = version;
    for (const waiter of this.#hardwareWaiters) waiter.resolve(version);
    this.#hardwareWaiters.clear();
    this.#emit("hardwareversion", { version });
  }
  #waitForHardwareVersion(waitMs) {
    if (this.#hardwareVersion !== null) return Promise.resolve(this.#hardwareVersion);
    if (!this.#notify) return Promise.reject(new Error("PadBot did not expose a notification characteristic for its hardware-version reply."));
    return new Promise((resolve, reject) => {
      const waiter = { resolve: (version) => { clearTimeout(waiter.timer); resolve(version); }, reject: (error) => { clearTimeout(waiter.timer); reject(error); } };
      waiter.timer = setTimeout(() => { this.#hardwareWaiters.delete(waiter); reject(new Error("PadBot did not report a hardware version after ';'.")); }, waitMs);
      this.#hardwareWaiters.add(waiter);
    });
  }
  #cleanup() { this.#cancelMotion(); this.#session += 1; this.#ready = false; for (const waiter of this.#hardwareWaiters) waiter.reject(aborted()); this.#hardwareWaiters.clear(); this.#notify?.removeEventListener("characteristicvaluechanged", this.#onNotification); this.#device?.removeEventListener("gattserverdisconnected", this.#onDisconnected); this.#server = null; this.#service = null; this.#targets = []; this.#notify = null; this.#lastCommand = null; this.#hardwareVersion = null; }
  #assertConnected() { if (!this.connected) throw new Error("Robot is not connected."); if (this.#disconnecting) throw new Error("Disconnect is in progress."); }
  #cancelMotion() { for (const timer of this.#timers) clearTimeout(timer); this.#timers.clear(); return ++this.#motion; }
  #schedule(callback, delay, token) { const timer = setTimeout(() => { this.#timers.delete(timer); if (token !== this.#motion || !this.connected) return; callback().catch((error) => { if (error.name !== "AbortError") this.#emit("error", error); }); }, delay); this.#timers.add(timer); }
  #frames(command) {
    switch (this.#options.protocolMode) {
      case "mn": return [`m${command}n`];
      case "pq": return [`p${command}q`];
      case "auto": return [command, `m${command}n`, `p${command}q`];
      case "sdk": {
        // Exact version map from cn.inbot.padbotsdk.d.e in PadBot SDK 3.1.
        if (command === COMMANDS.HARDWARE && this.#hardwareVersion === null) return [command];
        if (this.#hardwareVersion === null) throw new Error("PadBot hardware version is unknown. Query ';' and wait for the `ver` notification first.");
        if ((this.#hardwareVersion >= 1802 && this.#hardwareVersion <= 1899) || (this.#hardwareVersion >= 2000 && this.#hardwareVersion <= 2099)) return [`m${command}n`];
        if (this.#hardwareVersion >= 1902 && this.#hardwareVersion <= 1999) return [`p${command}q`];
        return [command];
      }
      default: return [command];
    }
  }
  #send(command, token = null) {
    const session = this.#session; const targets = this.#targets.slice(); const check = () => { if (session !== this.#session || (token !== null && token !== this.#motion)) throw aborted(); if (!this.connected) throw new Error("Robot is not connected."); };
    const operation = this.#queue.then(async () => { check(); const writes = []; const failures = []; for (const frame of this.#frames(command)) for (const characteristic of targets) { check(); try { const bytes = new TextEncoder().encode(frame); if (characteristic.properties.writeWithoutResponse && characteristic.writeValueWithoutResponse) await characteristic.writeValueWithoutResponse(bytes); else if (characteristic.writeValueWithResponse) await characteristic.writeValueWithResponse(bytes); else await characteristic.writeValue(bytes); writes.push({ frame, characteristicUuid: characteristic.uuid }); } catch (error) { failures.push({ frame, characteristicUuid: characteristic.uuid, error }); } } check(); if (!writes.length) throw new AggregateError(failures.map((item) => item.error), `All BLE writes failed for ${command}.`); this.#lastCommand = command; const result = { command, writes, failures }; this.#emit("command", result); return result; });
    this.#queue = operation.catch(() => {}); return operation;
  }
  async sendCommand(command) { if (typeof command !== "string" || !command.length) throw new TypeError("Command must be a non-empty string."); this.#assertConnected(); if (command === COMMANDS.STOP) return this.stop(); return this.#send(command, this.#cancelMotion()); }
  async setSpeed(value) { const name = speedName(value); this.#assertConnected(); const result = await this.#send(SPEEDS[name]); this.#speed = name; return result; }
  async drive(direction, { durationMs = 0, repeatMs = 220 } = {}) { if (typeof direction !== "string" || !Object.hasOwn(DIRECTIONS, direction)) throw new RangeError("Unknown drive direction."); delayValue(durationMs, "durationMs"); delayValue(repeatMs, "repeatMs"); this.#assertConnected(); const token = this.#cancelMotion(); const command = DIRECTIONS[direction]; const send = async () => { try { const result = await this.#send(command, token); if (token === this.#motion && repeatMs) this.#schedule(send, repeatMs, token); return result; } catch (error) { if (token === this.#motion && this.connected && !this.#disconnecting) await this.stop().catch(() => {}); throw error; } }; const result = await send(); if (token === this.#motion && durationMs) this.#schedule(() => this.stop(), durationMs, token); return result; }
  forward(options) { return this.drive("forward", options); } backward(options) { return this.drive("backward", options); } left(options) { return this.drive("left", options); } right(options) { return this.drive("right", options); } forwardLeft(options) { return this.drive("forwardLeft", options); } forwardRight(options) { return this.drive("forwardRight", options); } backwardLeft(options) { return this.drive("backwardLeft", options); } backwardRight(options) { return this.drive("backwardRight", options); } headUp(options) { return this.drive("headUp", options); } headDown(options) { return this.drive("headDown", options); }
  async stop() { this.#assertConnected(); const token = this.#cancelMotion(); this.#schedule(() => this.#send(COMMANDS.STOP, token), 90, token); this.#schedule(() => this.#send(COMMANDS.STOP, token), 180, token); return this.#send(COMMANDS.STOP, token); }
  async #query(command) { this.#assertConnected(); return this.#send(command); }
  queryBattery() { return this.#query(COMMANDS.BATTERY); } queryInfrared() { return this.#query(COMMANDS.INFRARED); } queryInfo() { return this.#query(COMMANDS.INFO); }
  async queryHardwareVersion({ waitMs = 0 } = {}) { this.#assertConnected(); const waiting = waitMs ? this.#waitForHardwareVersion(waitMs) : null; const result = await this.#send(COMMANDS.HARDWARE); return waiting ? waiting : result; }
  initializeSpeed() { return this.#query(COMMANDS.SPEED_SETUP); } dock() { return this.sendCommand(COMMANDS.DOCK); } undock() { return this.sendCommand(COMMANDS.UNDOCK); }
}
export default PadBot;
