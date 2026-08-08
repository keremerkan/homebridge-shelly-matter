import { promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';

import type { API, DynamicPlatformPlugin, Logging, MatterAccessory, MatterAPI, PlatformConfig } from 'homebridge';
import { AnsiLogger, LogLevel, TimestampFormat } from 'node-ansi-logger';

import { configForDevice, deviceConfigs } from './deviceConfig.js';
import { DATA_DIR, DEVICES_FILE, MIN_HOMEBRIDGE, PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import { accessorySignature, attachComponentUpdates, buildShellyAccessories, cachedAccessoryDeviceId, expectedShellsFromCache, mappedComponents, pushCurrentState } from './shellyAccessory.js';
import type { DiscoveredDevice } from './shelly/mdnsScanner.js';
import { Shelly } from './shelly/shelly.js';
import type { ShellyComponent } from './shelly/shellyComponent.js';
import { deepEqual, getErrorMessage } from './shelly/utils/index.js';
import { WsClient } from './shelly/wsClient.js';
import { ShellyDevice } from './shelly/shellyDevice.js';

/** Snapshot of a seen device, persisted for the settings UI device picker. */
interface KnownDevice {
  id: string;
  host: string;
  gen: number;
  model: string | null;
  name: string | null;
  channels: number | null;
  /** Component kind per channel ('switch' | 'cover' | 'dimmer'), once the device has connected. */
  kinds: string[] | null;
}

const HOST_RETRY_MS = 60_000;
const ATTACH_SETTLE_MS = 1000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class ShellyMatterPlatform implements DynamicPlatformPlugin {
  readonly matterAccessories = new Map<string, MatterAccessory>();
  readonly matter!: MatterAPI;
  private readonly shelly?: Shelly;
  private readonly shellyLog!: AnsiLogger;
  private readonly hostRetryTimers = new Map<string, NodeJS.Timeout>();
  private registrationQueue: Promise<void> = Promise.resolve();
  private readonly pendingUpdateAttach: { device: ShellyDevice; accessory: MatterAccessory }[] = [];
  private attachTimer?: NodeJS.Timeout;
  private readonly knownDevices = new Map<string, KnownDevice>();
  private saveQueue: Promise<void> = Promise.resolve();
  private saveTimer?: NodeJS.Timeout;
  private readonly registeredSignatures = new Map<string, string>();
  /** The accessory UUIDs currently registered for a device - one entry grouped, several when splitChannels is on. */
  private readonly uuidsByDevice = new Map<string, string[]>();
  /** The current rotation generation per device (see ShellyAccessoryContext.generation). */
  private readonly generationByDevice = new Map<string, number>();
  private dataPath = '';
  private stopped = false;

  constructor(
    readonly log: Logging,
    readonly config: PlatformConfig,
    readonly api: API,
  ) {
    if (!api.versionGreaterOrEqual?.(MIN_HOMEBRIDGE)) {
      log.error(
        `This plugin requires Homebridge v${MIN_HOMEBRIDGE} or later - you are running v${api.serverVersion}, `
        + 'whose Matter support is missing fixes the plugin depends on (Apple Home would stop responding ~30s after pairing). '
        + 'Update Homebridge: sudo npm install -g homebridge (or update from the Homebridge UI).',
      );
      return;
    }
    if (!api.isMatterAvailable?.() || !api.matter || !api.isMatterEnabled?.()) {
      log.warn(
        'Matter is not enabled on this bridge. This is a Matter-only plugin (it publishes no HAP accessories) - '
        + 'in the Homebridge UI, open this plugin\'s bridge settings and turn on "Enable Matter" '
        + '(you can also turn off "Enable HAP", which this plugin does not use). '
        + 'If you want classic HAP exposure without energy metering, use one of the HAP Shelly plugins instead.',
      );
      return;
    }
    this.matter = api.matter;

    // A child bridge with HAP still enabled advertises a HAP QR code that
    // pairs an EMPTY bridge (this plugin publishes no HAP accessories) -
    // users have paired it and seen no devices. Point them at the Matter
    // code. Homebridge strips `_bridge` from the config it hands to plugins
    // (childBridgeFork), so the bridge's HAP setting is only visible in the
    // raw config file.
    try {
      const raw = JSON.parse(readFileSync(api.user.configPath(), 'utf8')) as { platforms?: { platform?: string; _bridge?: { hap?: { enabled?: boolean } } }[] };
      const block = raw.platforms?.find((platform) => platform.platform === PLATFORM_NAME);
      if (block?._bridge && block._bridge.hap?.enabled !== false) {
        log.warn(
          'This bridge has HAP enabled, but this plugin publishes no HAP accessories - pairing the HAP QR code adds an empty bridge with no devices. '
          + 'Pair Apple Home with the MATTER pairing code instead (shown earlier in this startup log), and consider turning off "Enable HAP" in the bridge settings to remove the misleading QR code.',
        );
      }
    } catch {
      // Config unreadable from this process - skip the hint.
    }

    this.shellyLog = new AnsiLogger({
      logName: 'ShellyMatter',
      logTimestampFormat: TimestampFormat.TIME_MILLIS,
      logLevel: this.config.debug === true ? LogLevel.DEBUG : LogLevel.INFO,
    });
    this.shelly = new Shelly(this.shellyLog, (this.config.username as string) ?? 'admin', this.config.password as string | undefined);

    // Shelly devices routinely close idle WebSockets and the client reconnects
    // transparently - connection cycling is routine noise, so the transport
    // loggers only speak up for warnings unless debug logging is enabled.
    const transportLevel = this.config.debug === true ? LogLevel.DEBUG : LogLevel.WARN;
    WsClient.logLevel = transportLevel;
    this.shelly.wsServer.log.logLevel = transportLevel;

    api.on('didFinishLaunching', () => void this.start());
    api.on('shutdown', () => this.stop());
  }

  /** HAP accessories are not used by this plugin. */
  configureAccessory(): void {}

  /**
   * Appends work to the serialized registration queue. The queue must never
   * reject (a rejected tail would wedge every later registration), so every
   * append routes its error into the log here.
   */
  private enqueue(errorLabel: string, task: () => Promise<void> | void): void {
    this.registrationQueue = this.registrationQueue
      .then(task)
      .catch((error: unknown) => this.log.error(`${errorLabel}: ${getErrorMessage(error)}`));
  }

  /** The unregister mirror of registerVerified's bookkeeping: drops every record of the accessory. */
  private async unregisterAccessory(accessory: MatterAccessory): Promise<void> {
    await this.matter.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    this.matterAccessories.delete(accessory.UUID);
    this.registeredSignatures.delete(accessory.UUID);
  }

  /** A component of a connected device, or undefined while it is offline. */
  shellyComponent(deviceId: string, componentId: string): ShellyComponent | undefined {
    return this.shelly?.getDevice(deviceId)?.getComponent(componentId);
  }

  configureMatterAccessory(accessory: MatterAccessory): void {
    this.log.debug(`Restored cached Matter accessory ${accessory.displayName} (${accessory.UUID})`);
    this.matterAccessories.set(accessory.UUID, accessory);
  }

  private async start(): Promise<void> {
    if (!this.shelly) return;

    const dataPath = path.join(this.api.user.storagePath(), DATA_DIR);
    await fs.mkdir(dataPath, { recursive: true });
    this.shelly.dataPath = dataPath;
    this.dataPath = dataPath;

    // Re-register cached accessories so the bridge comes up with a complete
    // parts list - and reconcile them against the CURRENT config while the
    // Matter node is still offline (Homebridge defers online until these
    // registrations settle). Composition changes made in the settings
    // (splitChannels, type changes, hidden channels) are therefore applied
    // before paired controllers can see the structure: a live rotation on a
    // commissioned bridge desyncs Apple Home (the bridge record is rebuilt
    // and devices vanish until the hub reboots), while an offline transition
    // is handled like any reboot. No quiet-delay is needed here anymore -
    // registering immediately is what keeps the node offline until we are
    // done.
    const cachedByDevice = new Map<string, MatterAccessory[]>();
    for (const cached of this.matterAccessories.values()) {
      const deviceId = cachedAccessoryDeviceId(cached);
      if (deviceId === undefined) continue;
      const list = cachedByDevice.get(deviceId) ?? [];
      list.push(cached);
      cachedByDevice.set(deviceId, list);
    }
    for (const [deviceId, cachedList] of cachedByDevice) {
      if (this.isHidden(deviceId)) {
        // Remove hidden devices from bridge and cache.
        for (const cached of cachedList) {
          this.enqueue(`Failed to unregister hidden Shelly ${deviceId}`, () => this.unregisterAccessory(cached));
        }
        continue;
      }
      const reconciled = expectedShellsFromCache(this, deviceId, cachedList);
      if (!reconciled) continue;
      const expected = reconciled.shells;
      this.generationByDevice.set(deviceId, reconciled.generation);
      const expectedUuids = new Set(expected.map((shell) => shell.UUID));
      for (const cached of cachedList) {
        if (expectedUuids.has(cached.UUID)) continue;
        this.enqueue(`Failed to unregister stale Shelly ${deviceId}`, async () => {
          this.log.info(`Shelly ${deviceId} composition changed while offline - removing ${cached.displayName} before the bridge goes online.`);
          await this.unregisterAccessory(cached);
        });
      }
      for (const shell of expected) {
        this.enqueue(`Failed to register cached Shelly ${deviceId}`, async () => {
          this.log.info(`Registering ${shell.displayName} from cache.`);
          if (await this.registerVerified(shell, shell.displayName)) {
            const uuids = this.uuidsByDevice.get(deviceId) ?? [];
            if (!uuids.includes(shell.UUID)) uuids.push(shell.UUID);
            this.uuidsByDevice.set(deviceId, uuids);
          }
        });
      }
    }

    this.shelly.on('discovered', (discovered: DiscoveredDevice) => {
      if (discovered.port === 9000) {
        this.log.warn(`Shelly ${discovered.id} at ${discovered.host} runs unofficial firmware (port 9000) - skipping.`);
        return;
      }
      // The scanner matches any mDNS name starting with 'shelly' - real device
      // ids end in a MAC fragment of at least 6 hex chars. Filters name-alikes
      // (e.g. a HAP bridge someone named "Shelly...").
      if (!/^shelly[a-z0-9]*-[0-9a-f]{6,}$/i.test(discovered.id)) {
        this.log.debug(`Ignoring mDNS entry ${discovered.id} at ${discovered.host} - not a Shelly device id.`);
        return;
      }
      // Record every sighting - including hidden devices, so the
      // settings UI can list them for un-hiding.
      this.rememberDevice({ id: discovered.id, host: discovered.host, gen: discovered.gen, model: null, name: null, channels: null, kinds: null });
      if (this.isHidden(discovered.id, discovered.host)) {
        this.log.debug(`Shelly ${discovered.id} is configured as hidden - skipping.`);
        return;
      }
      const existing = this.shelly?.getDevice(discovered.id);
      if (existing) {
        if (existing.host !== discovered.host) {
          this.log.warn(`Shelly ${discovered.id} moved from ${existing.host} to ${discovered.host} - reconnecting.`);
          existing.host = discovered.host;
          if (existing.gen === 1) {
            void this.shelly?.coapServer.registerDevice(existing.host, existing.id, existing.sleepMode);
          } else {
            existing.wsClient?.stop();
            existing.wsClient?.setHost(existing.host);
            existing.wsClient?.start();
          }
        }
        return;
      }
      void this.addHost(discovered.host);
    });

    this.shelly.on('add', (device: ShellyDevice) => {
      // Serialize registrations: concurrent parts-list changes race matter.js
      // endpoint locks ("Cannot lock ... synchronously") when devices come
      // online together, and controllers can miss the dropped notification.
      this.enqueue(`Failed to register Shelly ${device.id}`, () => this.registerDevice(device));
    });

    for (const entry of deviceConfigs(this.config)) {
      if (entry.host && entry.hidden !== true) void this.addHost(entry.host);
    }

    if (this.config.mdnsDiscover !== false) {
      this.shelly.mdnsScanner.start(0, 10 * 60 * 1000, this.config.interfaceName as string | undefined, 'udp4', this.config.debug === true);
    }
  }

  private stop(): void {
    this.stopped = true;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    if (this.attachTimer) clearTimeout(this.attachTimer);
    for (const timer of this.hostRetryTimers.values()) clearTimeout(timer);
    this.hostRetryTimers.clear();
    this.shelly?.destroy();
  }

  private async addHost(host: string): Promise<void> {
    if (!this.shelly || this.shelly.hasDeviceHost(host)) return;
    const device = await ShellyDevice.create(this.shelly, this.shellyLog, host).catch((error: unknown) => {
      this.log.error(`Error creating Shelly device at ${host}: ${getErrorMessage(error)}`);
      return undefined;
    });
    if (!device) {
      this.log.warn(`Could not reach Shelly at ${host}, retrying in ${HOST_RETRY_MS / 1000}s.`);
      const timer = setTimeout(() => {
        this.hostRetryTimers.delete(host);
        void this.addHost(host);
      }, HOST_RETRY_MS);
      this.hostRetryTimers.set(host, timer);
      return;
    }
    await this.shelly.addDevice(device);
  }

  /**
   * Registers and verifies. Homebridge swallows registrations that arrive
   * before the Matter server finished starting ("Matter server not started"
   * is logged but not thrown), so registration is confirmed by reading state
   * back and retried until the server is ready.
   */
  private async registerVerified(accessory: MatterAccessory, label: string): Promise<boolean> {
    // Every accessory this plugin builds is composed with onOff on every
    // part - confirm registration by reading the first part's first cluster.
    const part = accessory.parts?.[0];
    const probeCluster = part ? Object.keys(part.clusters)[0] : 'onOff';
    const verified = async (): Promise<boolean> => (await this.matter.getAccessoryState(accessory.UUID, probeCluster, part?.id)) !== undefined;

    for (let attempt = 1; attempt <= 8 && !this.stopped; attempt++) {
      try {
        await this.matter.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      } catch (error) {
        // Homebridge >= 2.2.2 rejects registrations that arrive before the
        // Matter server is running (previously they were silently dropped) -
        // treat it like a failed verification and keep retrying.
        this.log.debug(`Registration of ${label} rejected (${getErrorMessage(error)}) - retrying.`);
      }
      // On child bridges registration is dispatched through an event and
      // completes asynchronously - poll for a while before assuming it was
      // dropped (which happens when the Matter server is not started yet)
      // and re-registering.
      for (let poll = 0; poll < 40 && !this.stopped; poll++) {
        if (await verified()) {
          this.registeredSignatures.set(accessory.UUID, accessorySignature(accessory));
          this.matterAccessories.set(accessory.UUID, accessory);
          return true;
        }
        await sleep(250);
      }
      if (attempt === 1) this.log.warn(`Matter server not ready yet - retrying registration of ${label} until it is.`);
    }
    if (!this.stopped) this.log.error(`Could not register ${label}: the Matter server never became ready.`);
    return false;
  }

  /** Merges a device sighting into the known-device list and persists it for the settings UI. */
  private rememberDevice(entry: KnownDevice): void {
    const existing = this.knownDevices.get(entry.id);
    const merged: KnownDevice = {
      ...entry,
      model: entry.model ?? existing?.model ?? null,
      name: entry.name ?? existing?.name ?? null,
      channels: entry.channels ?? existing?.channels ?? null,
      kinds: entry.kinds ?? existing?.kinds ?? null,
    };
    if (existing && deepEqual(existing, merged)) return;
    this.knownDevices.set(entry.id, merged);
    this.persistKnownDevices();
  }

  /**
   * Debounced + serialized save: discovery bursts update many devices in the
   * same second, and concurrent write/rename pairs on the same tmp file race
   * each other. Write-then-rename keeps the file crash-safe.
   */
  private persistKnownDevices(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.saveQueue = this.saveQueue
        .then(async () => {
          const file = path.join(this.dataPath, DEVICES_FILE);
          await fs.writeFile(`${file}.tmp`, JSON.stringify([...this.knownDevices.values()], null, 2));
          await fs.rename(`${file}.tmp`, file);
        })
        .catch((error: unknown) => {
          this.log.error(`Failed to save devices.json: ${getErrorMessage(error)}`);
        });
    }, 500);
  }

  /**
   * Attaches update forwarding only after registrations settle. On a
   * commissioned bridge (every restart once paired), live state transactions
   * from already-registered devices race the next registration's parts-list
   * notify on matter.js endpoint locks ("Cannot lock ... synchronously").
   */
  private scheduleUpdateAttach(): void {
    if (this.attachTimer) clearTimeout(this.attachTimer);
    this.attachTimer = setTimeout(() => {
      this.attachTimer = undefined;
      for (const { device, accessory } of this.pendingUpdateAttach.splice(0)) {
        attachComponentUpdates(this, device, accessory);
      }
    }, ATTACH_SETTLE_MS);
  }

  /** Passes host through so host-only entries hide their device on every discovery path. */
  private isHidden(deviceId: string, host?: string): boolean {
    return configForDevice(this.config, deviceId, host)?.hidden === true;
  }

  private async registerDevice(device: ShellyDevice): Promise<void> {
    const mapped = mappedComponents(device);
    this.rememberDevice({
      id: device.id,
      host: device.host,
      gen: device.gen,
      model: device.model,
      name: device.name,
      channels: mapped.length,
      kinds: mapped.map(({ kind }) => kind),
    });
    if (this.isHidden(device.id, device.host)) {
      this.log.info(`Shelly ${device.id} is configured as hidden - not registering.`);
      return;
    }
    let generation = this.generationByDevice.get(device.id) ?? 0;
    let accessories = buildShellyAccessories(this, device, generation);
    if (accessories.length === 0) {
      this.log.info(`Shelly ${device.id} (${device.model}) at ${device.host} has no supported components yet - skipping.`);
      return;
    }
    // A composition change (type, splitChannels, live device shape) rotates
    // accessory identity: bump the generation so the rotation lands on a
    // NEVER previously used identity, and unregister the previous identities
    // first so controllers see a clean remove+add (Apple Home breaks on
    // reappearances of identities it has seen before).
    const previous = this.uuidsByDevice.get(device.id) ?? [];
    let newUuids = new Set(accessories.map((accessory) => accessory.UUID));
    const rotated = previous.length > 0 && (previous.length !== newUuids.size || previous.some((uuid) => !newUuids.has(uuid)));
    if (rotated) {
      generation += 1;
      this.generationByDevice.set(device.id, generation);
      accessories = buildShellyAccessories(this, device, generation);
      newUuids = new Set(accessories.map((accessory) => accessory.UUID));
      for (const previousUuid of previous) {
        const stale = this.matterAccessories.get(previousUuid);
        if (stale) {
          this.log.info(`Shelly ${device.id} identity rotated (composition changed) - removing previous registration ${stale.displayName}.`);
          await this.unregisterAccessory(stale);
        }
      }
    }
    this.uuidsByDevice.set(device.id, [...newUuids]);

    for (const accessory of accessories) {
      const signature = accessorySignature(accessory);
      const registered = this.registeredSignatures.get(accessory.UUID);
      if (registered === signature) {
        // Already registered from the cache with the same structure - just feed it.
        this.log.info(`Shelly ${device.id} (${accessory.displayName}) matches its cached registration - pushing current state.`);
        pushCurrentState(this, device, accessory);
      } else {
        if (registered !== undefined) {
          this.log.info(`Shelly ${device.id} (${accessory.displayName}) changed since its cached registration - re-registering.`);
          const cached = this.matterAccessories.get(accessory.UUID);
          if (cached) await this.unregisterAccessory(cached);
        }
        this.log.info(`Registering ${accessory.displayName} (${device.model}, gen ${device.gen}) at ${device.host} as Matter accessory.`);
        if (!(await this.registerVerified(accessory, accessory.displayName))) continue;
      }
      this.pendingUpdateAttach.push({ device, accessory });
    }
    this.scheduleUpdateAttach();

    device.on('online', () => this.log.info(`Shelly ${device.id} is online.`));
    device.on('offline', () => this.log.warn(`Shelly ${device.id} is offline.`));
  }
}
