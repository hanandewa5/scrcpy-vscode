/**
 * Device Service - manages device connections and operations
 *
 * This service handles all device connection logic but delegates state
 * ownership to AppStateManager. It manages ScrcpyConnection instances
 * and device monitoring.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { Bonjour, Service } from 'bonjour-service';
import { ScrcpyConnection, ScrcpyConfig, ClipboardAPI, VideoCodecType } from './ScrcpyConnection';
import { execFile, execFileSync, spawn, ChildProcess } from 'child_process';
import { AppStateManager } from './AppStateManager';
import {
  DeviceInfo,
  DeviceDetailedInfo,
  ConnectionState,
  VideoCodec,
  DeviceUISettings,
  DarkMode,
  NavigationMode,
} from './types/AppState';
import { ActionType } from './types/Actions';

// Re-export types for backward compatibility
export type { DeviceInfo, DeviceDetailedInfo, ConnectionState };

/**
 * Shared output channel for WiFi pairing diagnostics. Visible in
 * View > Output > "Scrcpy: WiFi Pairing".
 */
let pairingLogChannel: vscode.OutputChannel | undefined;
function pairLog(msg: string): void {
  if (!pairingLogChannel) {
    pairingLogChannel = vscode.window.createOutputChannel('Scrcpy: WiFi Pairing');
  }
  const ts = new Date().toISOString().split('T')[1].replace('Z', '');
  const line = `[${ts}] ${msg}`;
  pairingLogChannel.appendLine(line);
  // Also log to the extension host console for DevTools visibility.
  console.log('[scrcpy-pair]', msg);
}
export function showPairingLog(): void {
  if (!pairingLogChannel) {
    pairingLogChannel = vscode.window.createOutputChannel('Scrcpy: WiFi Pairing');
  }
  pairingLogChannel.show(true);
}

/**
 * Callback types for video/audio frames (high-frequency, bypass state)
 */
export type VideoFrameCallback = (
  deviceId: string,
  data: Uint8Array,
  isConfig: boolean,
  isKeyFrame: boolean,
  width?: number,
  height?: number,
  codec?: VideoCodecType
) => void;

export type AudioFrameCallback = (deviceId: string, data: Uint8Array, isConfig: boolean) => void;

/**
 * Callback for status messages
 */
export type StatusCallback = (deviceId: string, status: string) => void;

/**
 * Callback for errors
 * @param deviceId - The device ID associated with the error
 * @param message - Human-readable error message
 * @param error - Optional original error object for type checking
 */
export type ErrorCallback = (deviceId: string, message: string, error?: Error) => void;

/**
 * Internal session data for a connected device
 */
interface DeviceSession {
  deviceId: string;
  deviceInfo: DeviceInfo;
  connection: ScrcpyConnection | null;
  isPaused: boolean;
  retryCount: number;
  isReconnecting: boolean;
  isDisposed: boolean;
  effectiveCodec: 'h264' | 'h265' | 'av1';

  // Replay state for tab switching
  lastWidth: number;
  lastHeight: number;
  lastConfigData: Uint8Array | null;
  lastKeyFrameData: Uint8Array | null;
  lastCodec: VideoCodecType;
}

// Codec fallback chain: av1 -> h265 -> h264
const CODEC_FALLBACK: Record<string, 'h264' | 'h265' | 'av1' | null> = {
  av1: 'h265',
  h265: 'h264',
  h264: null, // No fallback for h264
};

const RETRY_DELAY_MS = 1500;
const INFO_CACHE_TTL = 30000; // 30 seconds

/**
 * Service for managing device connections
 *
 * Delegates state ownership to AppStateManager but manages connections,
 * device monitoring, and operations.
 */
export class DeviceService {
  // Internal session data (connections, replay state)
  private sessions = new Map<string, DeviceSession>();

  // Device monitoring
  private trackDevicesProcess: ChildProcess | null = null;
  private trackDevicesRestartTimeout: NodeJS.Timeout | null = null;
  private knownDeviceSerials = new Set<string>();
  private deviceListUpdateChain: Promise<void> = Promise.resolve();

  // Device info caching
  private deviceInfoCache = new Map<string, { info: DeviceDetailedInfo; timestamp: number }>();
  private deviceInfoRefreshInterval: NodeJS.Timeout | null = null;

  constructor(
    private appState: AppStateManager,
    private videoFrameCallback: VideoFrameCallback,
    private audioFrameCallback: AudioFrameCallback,
    private statusCallback: StatusCallback,
    private errorCallback: ErrorCallback,
    private config: ScrcpyConfig,
    private clipboardAPI?: ClipboardAPI
  ) {}

  /**
   * Get the ADB command path from config
   */
  private getAdbCommand(): string {
    if (this.config.adbPath) {
      return path.join(this.config.adbPath, 'adb');
    }
    return 'adb';
  }

  /**
   * Get list of available ADB devices (excludes mDNS devices for cleaner UI)
   */
  async getAvailableDevices(): Promise<DeviceInfo[]> {
    const adbCmd = this.getAdbCommand();
    return new Promise((resolve) => {
      execFile(adbCmd, ['devices', '-l'], (error, stdout) => {
        if (error) {
          resolve([]);
          return;
        }

        const lines = stdout.trim().split('\n');
        const devices: DeviceInfo[] = [];

        for (let i = 1; i < lines.length; i++) {
          const parts = lines[i].trim().split(/\s+/);
          if (parts.length >= 2 && parts[1] === 'device') {
            const serial = parts[0];
            // Skip mDNS devices (they're duplicates of WiFi connections)
            if (serial.includes('._adb-tls-connect._tcp')) {
              continue;
            }
            const modelMatch = lines[i].match(/model:([^\s]+)/);
            const model = modelMatch ? modelMatch[1].replace(/_/g, ' ') : undefined;
            devices.push({
              serial,
              name: model || serial,
              model,
            });
          }
        }

        resolve(devices);
      });
    });
  }

  /**
   * Get detailed device information via ADB commands
   */
  async getDeviceInfo(serial: string): Promise<DeviceDetailedInfo> {
    const adbCmd = this.getAdbCommand();
    const execAdb = (args: string[]): Promise<string> => {
      return new Promise((resolve, reject) => {
        execFile(adbCmd, ['-s', serial, ...args], { timeout: 5000 }, (error, stdout, stderr) => {
          if (error) {
            reject(new Error(stderr || error.message));
          } else {
            resolve(stdout.trim());
          }
        });
      });
    };

    try {
      // Fetch all device properties in parallel for better performance
      const [
        model,
        manufacturer,
        androidVersion,
        sdkVersion,
        batteryInfo,
        storageInfo,
        resolutionInfo,
        ipInfo,
      ] = await Promise.all([
        execAdb(['shell', 'getprop', 'ro.product.model']).catch(() => 'Unknown'),
        execAdb(['shell', 'getprop', 'ro.product.manufacturer']).catch(() => 'Unknown'),
        execAdb(['shell', 'getprop', 'ro.build.version.release']).catch(() => 'Unknown'),
        execAdb(['shell', 'getprop', 'ro.build.version.sdk']).catch(() => '0'),
        execAdb(['shell', 'dumpsys', 'battery']).catch(() => ''),
        execAdb(['shell', 'df', '/data']).catch(() => ''),
        execAdb(['shell', 'wm', 'size']).catch(() => ''),
        execAdb(['shell', 'sh', '-c', 'ip route | grep wlan']).catch(() => ''),
      ]);

      // Parse battery info
      let batteryLevel = 0;
      let batteryCharging = false;
      if (batteryInfo) {
        const levelMatch = batteryInfo.match(/level:\s*(\d+)/);
        if (levelMatch) {
          batteryLevel = parseInt(levelMatch[1], 10);
        }
        // Check if charging (status: 2 = charging, 5 = full)
        const statusMatch = batteryInfo.match(/status:\s*(\d+)/);
        if (statusMatch) {
          const status = parseInt(statusMatch[1], 10);
          batteryCharging = status === 2 || status === 5;
        }
      }

      // Parse storage info (df output format: Filesystem Size Used Avail Use% Mounted)
      let storageTotal = 0;
      let storageUsed = 0;
      if (storageInfo) {
        const lines = storageInfo.split('\n');
        // Find the line with /data (usually the second line)
        for (const line of lines) {
          if (line.includes('/data')) {
            const parts = line.trim().split(/\s+/);
            if (parts.length >= 3) {
              // Convert from KB to bytes (df uses 1K blocks by default)
              storageTotal = this.parseStorageSize(parts[1]);
              storageUsed = this.parseStorageSize(parts[2]);
              break;
            }
          }
        }
      }

      // Parse screen resolution
      let screenResolution = 'Unknown';
      if (resolutionInfo) {
        const match = resolutionInfo.match(/Physical size:\s*(\d+)x(\d+)/);
        if (match) {
          screenResolution = `${match[1]}x${match[2]}`;
        }
      }

      // Parse IP address (extract IP from wlan route)
      let ipAddress: string | undefined;
      if (ipInfo) {
        const match = ipInfo.match(/src\s+(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/);
        if (match) {
          ipAddress = match[1];
        }
      }

      const info: DeviceDetailedInfo = {
        serial,
        model,
        manufacturer,
        androidVersion,
        sdkVersion: parseInt(sdkVersion, 10) || 0,
        batteryLevel,
        batteryCharging,
        storageTotal,
        storageUsed,
        screenResolution,
        ipAddress,
      };

      // Update AppState with device info
      this.appState.dispatch({ type: ActionType.SET_DEVICE_INFO, payload: { serial, info } });

      return info;
    } catch {
      // Return partial info if commands fail
      const info: DeviceDetailedInfo = {
        serial,
        model: 'Unknown',
        manufacturer: 'Unknown',
        androidVersion: 'Unknown',
        sdkVersion: 0,
        batteryLevel: 0,
        batteryCharging: false,
        storageTotal: 0,
        storageUsed: 0,
        screenResolution: 'Unknown',
        ipAddress: undefined,
      };
      return info;
    }
  }

  /**
   * Parse storage size from df output (handles K, M, G suffixes)
   */
  private parseStorageSize(sizeStr: string): number {
    const match = sizeStr.match(/^(\d+(?:\.\d+)?)([KMG])?$/);
    if (!match) {
      return 0;
    }

    const value = parseFloat(match[1]);
    const unit = match[2] || 'K'; // Default to KB

    switch (unit) {
      case 'K':
        return value * 1024;
      case 'M':
        return value * 1024 * 1024;
      case 'G':
        return value * 1024 * 1024 * 1024;
      default:
        return value;
    }
  }

  /**
   * Get cached device info or fetch if not cached/expired
   */
  async getCachedDeviceInfo(
    serial: string,
    forceRefresh: boolean = false
  ): Promise<DeviceDetailedInfo> {
    const now = Date.now();
    const cached = this.deviceInfoCache.get(serial);

    if (!forceRefresh && cached && now - cached.timestamp < INFO_CACHE_TTL) {
      return cached.info;
    }

    // Fetch fresh info
    const info = await this.getDeviceInfo(serial);
    this.deviceInfoCache.set(serial, { info, timestamp: now });
    return info;
  }

  /**
   * Start periodic refresh of device info for active sessions
   */
  private startDeviceInfoRefresh(): void {
    if (this.deviceInfoRefreshInterval) {
      return;
    }

    this.deviceInfoRefreshInterval = setInterval(async () => {
      // Refresh info for all connected devices
      for (const session of this.sessions.values()) {
        try {
          await this.getCachedDeviceInfo(session.deviceInfo.serial, true);
        } catch {
          // Ignore errors during refresh
        }
      }
    }, INFO_CACHE_TTL);
  }

  /**
   * Stop periodic refresh of device info
   */
  private stopDeviceInfoRefresh(): void {
    if (this.deviceInfoRefreshInterval) {
      clearInterval(this.deviceInfoRefreshInterval);
      this.deviceInfoRefreshInterval = null;
    }
  }

  /**
   * Pair with a device over WiFi using Android 11+ Wireless Debugging
   */
  async pairWifi(address: string, pairingCode: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const adb = spawn(this.getAdbCommand(), ['pair', address]);

      let stdout = '';
      let stderr = '';
      let pairingCodeSent = false;

      adb.stdout.on('data', (data: Buffer) => {
        const output = data.toString();
        stdout += output;

        if (!pairingCodeSent && output.toLowerCase().includes('enter pairing code')) {
          adb.stdin.write(pairingCode + '\n');
          pairingCodeSent = true;
        }
      });

      adb.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      adb.on('close', (code: number) => {
        const output = (stdout + stderr).toLowerCase();

        if (
          code === 0 &&
          (output.includes('successfully paired') || output.includes('paired to'))
        ) {
          resolve();
        } else if (output.includes('failed') || output.includes('error') || code !== 0) {
          reject(new Error(stderr || stdout || 'Pairing failed'));
        } else {
          resolve();
        }
      });

      adb.on('error', (error: Error) => {
        reject(error);
      });

      setTimeout(() => {
        adb.kill();
        reject(new Error('Pairing timed out'));
      }, 30000);
    });
  }

  /**
   * Connect to a device over WiFi using ADB
   */
  async connectWifi(ipAddress: string, port: number = 5555): Promise<DeviceInfo> {
    const address = `${ipAddress}:${port}`;
    const adbCmd = this.getAdbCommand();

    return new Promise((resolve, reject) => {
      execFile(adbCmd, ['connect', address], { timeout: 15000 }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr || error.message));
          return;
        }

        const output = stdout.toLowerCase();
        if (output.includes('connected to') || output.includes('already connected')) {
          try {
            const modelOutput = execFileSync(
              adbCmd,
              ['-s', address, 'shell', 'getprop', 'ro.product.model'],
              {
                timeout: 5000,
                encoding: 'utf8',
              }
            ).trim();

            resolve({
              serial: address,
              name: modelOutput || address,
              model: modelOutput || undefined,
            });
          } catch {
            resolve({
              serial: address,
              name: address,
              model: undefined,
            });
          }
        } else if (
          output.includes('failed') ||
          output.includes('unable') ||
          output.includes('cannot')
        ) {
          let errorMsg = stdout.trim();
          if (output.includes('connection refused') || output.includes('failed to connect')) {
            errorMsg +=
              '\n\n' +
              vscode.l10n.t(
                'For Android 11+, you need to pair the device first using "Pair new device".'
              );
          }
          reject(new Error(errorMsg));
        } else {
          resolve({
            serial: address,
            name: address,
            model: undefined,
          });
        }
      });
    });
  }

  /**
   * Browse for an `_adb-tls-pairing._tcp` service via mDNS using a real
   * Bonjour browser (independent of `adb mdns services`, which is broken
   * with the Openscreen backend on macOS).
   *
   * Resolves with `host:port` of the first service whose instance name
   * matches `serviceName`. Rejects on timeout/abort.
   */
  async findPairingServiceViaBonjour(
    serviceName: string,
    timeoutMs: number = 120000,
    signal?: AbortSignal
  ): Promise<string> {
    pairLog(
      `Bonjour: browsing _adb-tls-pairing._tcp for instance "${serviceName}" (timeout ${timeoutMs}ms)`
    );
    return this.browseBonjour('adb-tls-pairing', timeoutMs, signal, (svc) => {
      pairLog(
        `Bonjour pairing svc seen: name=${svc.name} host=${svc.host} port=${svc.port} ` +
          `addrs=${(svc.addresses || []).join(',')} referer=${svc.referer?.address || '?'}`
      );
      if (svc.name !== serviceName) {
        return null;
      }
      const host = svc.referer?.address || svc.host;
      if (!host || !svc.port) {
        return null;
      }
      return `${host}:${svc.port}`;
    }).then(
      (addr) => {
        pairLog(`Bonjour: pairing service resolved -> ${addr}`);
        return addr;
      },
      (err) => {
        pairLog(
          `Bonjour: pairing browse failed: ${err instanceof Error ? err.message : String(err)}`
        );
        throw err;
      }
    );
  }

  /**
   * Browse for an `_adb-tls-connect._tcp` service via mDNS using a real
   * Bonjour browser. Resolves with `host:port` for the first service
   * whose host address matches `ipAddress`.
   */
  async findConnectServiceViaBonjour(
    ipAddress: string,
    timeoutMs: number = 15000,
    signal?: AbortSignal
  ): Promise<string> {
    pairLog(`Bonjour: browsing _adb-tls-connect._tcp for IP ${ipAddress} (timeout ${timeoutMs}ms)`);
    return this.browseBonjour('adb-tls-connect', timeoutMs, signal, (svc) => {
      const addresses = [svc.referer?.address, ...(svc.addresses || [])].filter(
        (a): a is string => typeof a === 'string'
      );
      pairLog(
        `Bonjour connect svc seen: name=${svc.name} host=${svc.host} port=${svc.port} ` +
          `addrs=${addresses.join(',')}`
      );
      if (!addresses.includes(ipAddress)) {
        return null;
      }
      if (!svc.port) {
        return null;
      }
      return `${ipAddress}:${svc.port}`;
    }).then(
      (addr) => {
        pairLog(`Bonjour: connect service resolved -> ${addr}`);
        return addr;
      },
      (err) => {
        pairLog(
          `Bonjour: connect browse failed: ${err instanceof Error ? err.message : String(err)}`
        );
        throw err;
      }
    );
  }

  /**
   * Generic Bonjour browser: subscribes to `_<type>._tcp` and resolves
   * with the first service for which `match` returns a non-null value.
   * Also runs a one-shot `find()` so already-cached services resolve
   * immediately.
   */
  private browseBonjour(
    type: string,
    timeoutMs: number,
    signal: AbortSignal | undefined,
    match: (svc: Service) => string | null
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let bonjour: Bonjour;
      try {
        bonjour = new Bonjour();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        pairLog(`Bonjour: failed to bind UDP 5353 (${message}). Likely firewall/permission issue.`);
        reject(err);
        return;
      }
      let settled = false;

      const cleanup = () => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer) {
          clearTimeout(timer);
        }
        signal?.removeEventListener('abort', onAbort);
        try {
          browser.stop();
        } catch {
          // ignore
        }
        try {
          bonjour.destroy();
        } catch {
          // ignore
        }
      };

      const onAbort = () => {
        cleanup();
        reject(new Error('aborted'));
      };

      const onService = (svc: Service) => {
        const addr = match(svc);
        if (addr) {
          cleanup();
          resolve(addr);
        }
      };

      if (signal?.aborted) {
        bonjour.destroy();
        reject(new Error('aborted'));
        return;
      }
      signal?.addEventListener('abort', onAbort);

      const browser = bonjour.find({ type, protocol: 'tcp' }, onService);
      browser.on('up', onService);

      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for _${type}._tcp service`));
      }, timeoutMs);
    });
  }

  /**
   * Poll `adb mdns services` until a service whose instance name matches
   * `serviceName` is discovered. Returns the device's pairing `host:port`.
   *
   * Used by QR-code pairing: after the device scans the QR generated by the
   * extension, it advertises a `_adb-tls-pairing._tcp` service with the
   * instance name we encoded in the QR. We discover that service via mDNS
   * to learn which `host:port` to pair with.
   *
   * Polls `adb mdns services` every 1s, up to `timeoutMs`. Aborting `signal`
   * stops polling and rejects with a generic abort error.
   */
  async findMdnsPairingService(
    serviceName: string,
    timeoutMs: number = 120000,
    signal?: AbortSignal
  ): Promise<string> {
    const adbCmd = this.getAdbCommand();
    const startedAt = Date.now();
    pairLog(`adb mdns: polling for pairing service "${serviceName}" (timeout ${timeoutMs}ms)`);

    // Make sure mDNS discovery is enabled in adbd. Best-effort, ignored on
    // older adb versions.
    try {
      await new Promise<void>((resolve) => {
        execFile(adbCmd, ['mdns', 'check'], { timeout: 5000 }, () => resolve());
      });
    } catch {
      // ignore
    }

    return new Promise<string>((resolve, reject) => {
      const onAbort = () => {
        cleanup();
        reject(new Error('aborted'));
      };
      const cleanup = () => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        signal?.removeEventListener('abort', onAbort);
      };

      if (signal?.aborted) {
        reject(new Error('aborted'));
        return;
      }
      signal?.addEventListener('abort', onAbort);

      let timer: NodeJS.Timeout | null = null;

      const tick = () => {
        if (Date.now() - startedAt > timeoutMs) {
          cleanup();
          reject(new Error('Timed out waiting for device to scan QR code'));
          return;
        }

        execFile(adbCmd, ['mdns', 'services'], { timeout: 5000 }, (_err, stdout) => {
          if (signal?.aborted) {
            return;
          }

          // Output format (one per line):
          //   <instance-name>\t_adb-tls-pairing._tcp.\t<host>:<port>
          // The instance name we want to match is `serviceName`.
          const lines = (stdout || '').split('\n');
          for (const line of lines) {
            if (!line.includes('_adb-tls-pairing')) {
              continue;
            }
            const parts = line.trim().split(/\s+/);
            if (parts.length < 3) {
              continue;
            }
            const [name, , addr] = parts;
            if (name === serviceName && /:\d+$/.test(addr)) {
              cleanup();
              resolve(addr);
              return;
            }
          }

          timer = setTimeout(tick, 1000);
        });
      };

      tick();
    });
  }

  /**
   * Poll `adb mdns services` for an `_adb-tls-connect._tcp` advertisement
   * matching the given IP address. Used after QR pairing to auto-discover
   * the device's connection port (different from the pairing port).
   *
   * Returns `host:port` on success, rejects on timeout/abort.
   */
  async findMdnsConnectService(
    ipAddress: string,
    timeoutMs: number = 15000,
    signal?: AbortSignal
  ): Promise<string> {
    const adbCmd = this.getAdbCommand();
    const startedAt = Date.now();
    pairLog(`adb mdns: polling for connect service @ ${ipAddress} (timeout ${timeoutMs}ms)`);

    return new Promise<string>((resolve, reject) => {
      const onAbort = () => {
        cleanup();
        reject(new Error('aborted'));
      };
      const cleanup = () => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        signal?.removeEventListener('abort', onAbort);
      };

      if (signal?.aborted) {
        reject(new Error('aborted'));
        return;
      }
      signal?.addEventListener('abort', onAbort);

      let timer: NodeJS.Timeout | null = null;

      const tick = () => {
        if (Date.now() - startedAt > timeoutMs) {
          cleanup();
          reject(new Error('Timed out waiting for device connect service'));
          return;
        }

        execFile(adbCmd, ['mdns', 'services'], { timeout: 5000 }, (_err, stdout) => {
          if (signal?.aborted) {
            return;
          }

          const lines = (stdout || '').split('\n');
          for (const line of lines) {
            if (!line.includes('_adb-tls-connect')) {
              continue;
            }
            const parts = line.trim().split(/\s+/);
            if (parts.length < 3) {
              continue;
            }
            const addr = parts[parts.length - 1];
            const match = addr.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):(\d+)$/);
            if (match && match[1] === ipAddress) {
              cleanup();
              resolve(addr);
              return;
            }
          }

          timer = setTimeout(tick, 500);
        });
      };

      tick();
    });
  }

  /**
   * Poll `adb devices -l` for a connected device whose serial starts with
   * the given IP address. Used after QR/code pairing as a robust fallback
   * when `adb mdns services` is broken on the host but adb's internal
   * mDNS auto-connect still works (or the user manually connected).
   *
   * Matches both forms:
   *   - `<ip>:<port>` (plain WiFi)
   *   - `adb-XXXX-YYY._adb-tls-connect._tcp` (mDNS auto-connected)
   *
   * For the mDNS form we follow up with a `getprop` to confirm the IP.
   * Returns the matching serial on success, rejects on timeout/abort.
   */
  async findConnectedDeviceByIp(
    ipAddress: string,
    timeoutMs: number = 10000,
    signal?: AbortSignal
  ): Promise<string> {
    const adbCmd = this.getAdbCommand();
    const startedAt = Date.now();
    pairLog(`adb devices: polling for serial matching ${ipAddress} (timeout ${timeoutMs}ms)`);

    return new Promise<string>((resolve, reject) => {
      const onAbort = () => {
        cleanup();
        reject(new Error('aborted'));
      };
      const cleanup = () => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        signal?.removeEventListener('abort', onAbort);
      };

      if (signal?.aborted) {
        reject(new Error('aborted'));
        return;
      }
      signal?.addEventListener('abort', onAbort);

      let timer: NodeJS.Timeout | null = null;

      const tick = () => {
        if (Date.now() - startedAt > timeoutMs) {
          cleanup();
          reject(new Error('Timed out waiting for device to appear in adb devices'));
          return;
        }

        execFile(adbCmd, ['devices', '-l'], { timeout: 5000 }, (_err, stdout) => {
          if (signal?.aborted) {
            return;
          }

          const lines = (stdout || '').split('\n');
          const candidates: string[] = [];
          for (const line of lines.slice(1)) {
            const parts = line.trim().split(/\s+/);
            if (parts.length < 2 || parts[1] !== 'device') {
              continue;
            }
            const serial = parts[0];
            // Direct IP match: serial is `<ip>:<port>`
            if (serial.startsWith(`${ipAddress}:`)) {
              cleanup();
              resolve(serial);
              return;
            }
            // mDNS-auto-connected: verify by querying device IP
            if (serial.includes('_adb-tls-connect')) {
              candidates.push(serial);
            }
          }

          // Verify mDNS candidates one at a time
          const verifyNext = (i: number) => {
            if (i >= candidates.length) {
              timer = setTimeout(tick, 500);
              return;
            }
            execFile(
              adbCmd,
              ['-s', candidates[i], 'shell', 'ip', '-f', 'inet', 'addr', 'show', 'wlan0'],
              { timeout: 3000 },
              (err, out) => {
                if (signal?.aborted) {
                  return;
                }
                if (!err && out.includes(`inet ${ipAddress}/`)) {
                  cleanup();
                  resolve(candidates[i]);
                  return;
                }
                verifyNext(i + 1);
              }
            );
          };

          verifyNext(0);
        });
      };

      tick();
    });
  }

  /**
   * Pair with a device using a known password (non-interactive).
   *
   * Newer adb (>= 30.0.0) supports `adb pair <addr> <password>`. We still
   * fall back to interactive mode if the binary refuses the positional
   * argument.
   */
  async pairWifiWithPassword(address: string, password: string): Promise<void> {
    const adbCmd = this.getAdbCommand();
    pairLog(`adb pair ${address} <password>`);

    return new Promise((resolve, reject) => {
      execFile(adbCmd, ['pair', address, password], { timeout: 30000 }, (error, stdout, stderr) => {
        const output = (stdout + stderr).toLowerCase();
        pairLog(
          `adb pair result: code=${error?.code ?? 0} stdout=${stdout.trim()} stderr=${stderr.trim()}`
        );
        if (!error && (output.includes('successfully paired') || output.includes('paired to'))) {
          resolve();
          return;
        }

        // Older adb: fall back to interactive prompt.
        if (output.includes('usage:') || output.includes('enter pairing code')) {
          pairLog('adb pair: falling back to interactive mode');
          this.pairWifi(address, password).then(resolve, reject);
          return;
        }

        reject(new Error(stderr.trim() || stdout.trim() || 'Pairing failed'));
      });
    });
  }

  /**
   * Disconnect a WiFi device from ADB
   */
  async disconnectWifi(address: string): Promise<void> {
    const adbCmd = this.getAdbCommand();
    return new Promise((resolve, reject) => {
      execFile(adbCmd, ['disconnect', address], (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr || error.message));
          return;
        }
        resolve();
      });
    });
  }

  /**
   * Add and connect to a new device
   */
  async addDevice(deviceInfo: DeviceInfo): Promise<string> {
    // Prevent duplicate connections
    if (this.isDeviceConnected(deviceInfo.serial)) {
      throw new Error(vscode.l10n.t('Device already connected'));
    }

    // Enforce single-device mode when multi-device is disabled
    if (!this.appState.getSettings().multiDevice && this.sessions.size > 0) {
      throw new Error(
        vscode.l10n.t(
          'Multi-device mode is disabled. Disconnect the current device or enable "scrcpy.multiDevice" in settings.'
        )
      );
    }

    const deviceId = `device_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

    // Create internal session
    const session: DeviceSession = {
      deviceId,
      deviceInfo,
      connection: null,
      isPaused: false,
      retryCount: 0,
      isReconnecting: false,
      isDisposed: false,
      effectiveCodec: this.config.videoCodec,
      lastWidth: 0,
      lastHeight: 0,
      lastConfigData: null,
      lastKeyFrameData: null,
      lastCodec: 'h264',
    };

    this.sessions.set(deviceId, session);

    // Pause the currently active session (if any)
    const currentActiveId = this.appState.getActiveDeviceId();
    if (currentActiveId) {
      const oldSession = this.sessions.get(currentActiveId);
      if (oldSession) {
        oldSession.isPaused = true;
      }
    }

    // Add device to AppState
    this.appState.dispatch({
      type: ActionType.ADD_DEVICE,
      payload: {
        deviceId,
        serial: deviceInfo.serial,
        name: deviceInfo.name,
        model: deviceInfo.model,
        connectionState: 'connecting',
        isActive: true,
      },
    });

    // Set as active device
    this.appState.dispatch({ type: ActionType.SET_ACTIVE_DEVICE, payload: { deviceId } });

    // Add to allowed list for auto-connect (persistently)
    this.appState.dispatch({
      type: ActionType.ADD_ALLOWED_AUTO_CONNECT,
      payload: { serial: deviceInfo.serial },
    });
    this.appState.dispatch({
      type: ActionType.REMOVE_BLOCKED_AUTO_CONNECT,
      payload: { serial: deviceInfo.serial },
    });

    try {
      await this.connectSession(session);
    } catch {
      // Error already reported via callback
      // Remove failed session
      this.sessions.delete(deviceId);
      this.appState.dispatch({ type: ActionType.REMOVE_DEVICE, payload: { deviceId } });

      // Switch to first available session
      const deviceIds = this.appState.getDeviceIds();
      if (deviceIds.length > 0) {
        this.switchToDevice(deviceIds[0]);
      }
      throw new Error(vscode.l10n.t('Failed to connect'));
    }

    return deviceId;
  }

  /**
   * Connect a session with codec fallback
   */
  private async connectSession(session: DeviceSession): Promise<void> {
    // Update state to connecting
    this.appState.dispatch({
      type: ActionType.UPDATE_DEVICE,
      payload: { deviceId: session.deviceId, updates: { connectionState: 'connecting' } },
    });

    await this.connectWithCodecFallback(session);
  }

  /**
   * Attempt connection with codec fallback on failure
   */
  private async connectWithCodecFallback(session: DeviceSession): Promise<void> {
    const effectiveConfig: ScrcpyConfig = {
      ...this.config,
      videoCodec: session.effectiveCodec,
    };

    session.connection = new ScrcpyConnection(
      (data, isConfig, isKeyFrame, width, height, codec) => {
        // Store dimensions, config data, and codec for replay on resume
        if (width && height) {
          session.lastWidth = width;
          session.lastHeight = height;
          // Update AppState with dimensions
          this.appState.dispatch({
            type: ActionType.UPDATE_DEVICE,
            payload: {
              deviceId: session.deviceId,
              updates: {
                videoDimensions: { width, height },
                ...(codec ? { videoCodec: codec as VideoCodec } : {}),
              },
            },
          });
        }
        if (codec) {
          session.lastCodec = codec;
        }
        if (isConfig && data.length > 0) {
          session.lastConfigData = data;
        }
        if (isKeyFrame && data.length > 0) {
          session.lastKeyFrameData = data;
        }

        // Only forward frames if not paused
        if (!session.isPaused) {
          this.videoFrameCallback(
            session.deviceId,
            data,
            isConfig,
            isKeyFrame,
            width,
            height,
            codec
          );
        }
      },
      (status) => this.statusCallback(session.deviceId, status),
      effectiveConfig,
      session.deviceInfo.serial,
      undefined,
      this.clipboardAPI,
      (error) => this.handleDisconnect(session, error),
      (data, isConfig) => {
        if (!session.isPaused) {
          this.audioFrameCallback(session.deviceId, data, isConfig);
        }
      }
    );

    try {
      await session.connection.connect();
      await session.connection.startScrcpy();
      // Reset retry count on successful connection
      session.retryCount = 0;

      // Update state to connected
      this.appState.dispatch({
        type: ActionType.UPDATE_DEVICE,
        payload: { deviceId: session.deviceId, updates: { connectionState: 'connected' } },
      });

      // Clear any loading status message now that we're connected
      this.appState.dispatch({ type: ActionType.SET_STATUS_MESSAGE, payload: undefined });

      // Apply cached screenOff state (Control Center toggle overrides VS Code setting)
      const cachedSettings = this.appState.getControlCenterCache()[session.deviceInfo.serial];
      if (cachedSettings && typeof cachedSettings.screenOff === 'boolean' && session.connection) {
        // Cache exists — use its value (overrides config.screenOff applied earlier)
        if (cachedSettings.screenOff) {
          setTimeout(() => session.connection?.setDisplayPower(false), 150);
        } else if (this.config.screenOff) {
          // Cache says screen ON but config said OFF — undo the config's setDisplayPower
          setTimeout(() => session.connection?.setDisplayPower(true), 150);
        }
      }

      // Notify if we fell back to a different codec
      if (session.effectiveCodec !== this.config.videoCodec) {
        this.statusCallback(
          session.deviceId,
          vscode.l10n.t(
            'Using {0} codec (fallback from {1})',
            session.effectiveCodec,
            this.config.videoCodec
          )
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      // If the session was disposed (e.g. user pressed Disconnect mid-connect),
      // don't try fallback codecs or report an error — just clean up.
      if (session.isDisposed) {
        if (session.connection) {
          await session.connection.disconnect().catch(() => {});
          session.connection = null;
        }
        return;
      }

      // Check if we can fall back to another codec
      const fallbackCodec = CODEC_FALLBACK[session.effectiveCodec];
      if (fallbackCodec) {
        this.statusCallback(
          session.deviceId,
          vscode.l10n.t(
            '{0} codec failed, trying {1}...',
            session.effectiveCodec.toUpperCase(),
            fallbackCodec.toUpperCase()
          )
        );
        session.effectiveCodec = fallbackCodec;

        // Clean up failed connection
        if (session.connection) {
          await session.connection.disconnect();
          session.connection = null;
        }

        // Retry with fallback codec
        await this.connectWithCodecFallback(session);
        return;
      }

      // No more fallbacks available
      this.appState.dispatch({
        type: ActionType.UPDATE_DEVICE,
        payload: { deviceId: session.deviceId, updates: { connectionState: 'disconnected' } },
      });
      this.errorCallback(session.deviceId, message, error instanceof Error ? error : undefined);
      throw error;
    }
  }

  /**
   * Handle unexpected disconnect with auto-reconnect
   */
  private async handleDisconnect(session: DeviceSession, error: string): Promise<void> {
    // Don't reconnect if disposed or already reconnecting
    if (
      session.isDisposed ||
      session.isReconnecting ||
      this.appState.isBlockedAutoConnectDevice(session.deviceInfo.serial)
    ) {
      this.appState.dispatch({
        type: ActionType.UPDATE_DEVICE,
        payload: { deviceId: session.deviceId, updates: { connectionState: 'disconnected' } },
      });
      this.errorCallback(session.deviceId, error);
      this.handleSessionFailed(session.deviceId);
      return;
    }

    const maxRetries = this.config.autoReconnect ? this.config.reconnectRetries : 0;

    // Retry loop
    while (session.retryCount < maxRetries && !session.isDisposed) {
      session.isReconnecting = true;
      session.retryCount++;

      this.appState.dispatch({
        type: ActionType.UPDATE_DEVICE,
        payload: { deviceId: session.deviceId, updates: { connectionState: 'reconnecting' } },
      });

      this.statusCallback(
        session.deviceId,
        vscode.l10n.t('Reconnecting (attempt {0}/{1})...', session.retryCount, maxRetries)
      );

      // Wait before reconnecting
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));

      if (session.isDisposed) {
        session.isReconnecting = false;
        return;
      }

      try {
        // Cleanup old connection
        if (session.connection) {
          await session.connection.disconnect();
          session.connection = null;
        }

        // Try to reconnect
        await this.connectSession(session);
        session.isReconnecting = false;
        return; // Success!
      } catch {
        session.isReconnecting = false;
      }
    }

    // All retries exhausted
    this.appState.dispatch({
      type: ActionType.UPDATE_DEVICE,
      payload: { deviceId: session.deviceId, updates: { connectionState: 'disconnected' } },
    });
    this.errorCallback(session.deviceId, error);
    this.handleSessionFailed(session.deviceId);
  }

  /**
   * Switch active device tab
   */
  switchToDevice(deviceId: string): void {
    const newSession = this.sessions.get(deviceId);
    if (!newSession) {
      return;
    }

    const currentActiveId = this.appState.getActiveDeviceId();

    // Pause old active session
    if (currentActiveId && currentActiveId !== deviceId) {
      const oldSession = this.sessions.get(currentActiveId);
      if (oldSession) {
        oldSession.isPaused = true;
      }
    }

    // Activate new session
    newSession.isPaused = false;
    this.appState.dispatch({ type: ActionType.SET_ACTIVE_DEVICE, payload: { deviceId } });

    // Resume - send cached frames
    this.resumeSession(newSession);
  }

  /**
   * Resume a session by sending cached config and keyframe
   */
  private resumeSession(session: DeviceSession): void {
    if (session.lastWidth && session.lastHeight) {
      // First re-send config/dimensions with codec
      if (session.lastConfigData) {
        this.videoFrameCallback(
          session.deviceId,
          session.lastConfigData,
          true,
          false,
          session.lastWidth,
          session.lastHeight,
          session.lastCodec
        );
      } else {
        // Just dimensions with codec
        this.videoFrameCallback(
          session.deviceId,
          new Uint8Array(0),
          true,
          false,
          session.lastWidth,
          session.lastHeight,
          session.lastCodec
        );
      }

      // Then re-send last keyframe
      if (session.lastKeyFrameData) {
        this.videoFrameCallback(
          session.deviceId,
          session.lastKeyFrameData,
          false,
          true,
          undefined,
          undefined,
          session.lastCodec
        );
      }
    }
  }

  /**
   * Remove device session (user-initiated close)
   */
  async removeDevice(deviceId: string): Promise<void> {
    const session = this.sessions.get(deviceId);
    if (!session) {
      return;
    }

    // Mark as manually closed to prevent auto-reconnect
    const deviceSerial = session.deviceInfo.serial;
    this.knownDeviceSerials.add(deviceSerial);
    this.appState.dispatch({
      type: ActionType.REMOVE_ALLOWED_AUTO_CONNECT,
      payload: { serial: deviceSerial },
    });
    this.appState.dispatch({
      type: ActionType.ADD_BLOCKED_AUTO_CONNECT,
      payload: { serial: deviceSerial },
    });

    session.isDisposed = true;
    if (session.connection) {
      await session.connection.disconnect();
      session.connection = null;
    }
    this.sessions.delete(deviceId);

    // Remove from AppState
    this.appState.dispatch({ type: ActionType.REMOVE_DEVICE, payload: { deviceId } });

    // Check remaining devices
    const deviceIds = this.appState.getDeviceIds();

    if (deviceIds.length === 0) {
      // No devices left - clear any error/loading messages and show empty state
      this.appState.dispatch({
        type: ActionType.SET_STATUS_MESSAGE,
        payload: {
          type: 'empty',
          text: vscode.l10n.t(
            'No Android devices found.\n\nPlease connect a device and enable USB debugging.'
          ),
        },
      });
    } else if (this.appState.getActiveDeviceId() === null) {
      // If removed active device, switch to first available
      this.switchToDevice(deviceIds[0]);
    }
  }

  /**
   * Check if device is already connected
   */
  isDeviceConnected(serial: string): boolean {
    for (const session of this.sessions.values()) {
      if (session.deviceInfo.serial === serial) {
        return true;
      }
    }
    return false;
  }

  /**
   * Get session by device ID
   */
  private getSession(deviceId: string): DeviceSession | undefined {
    return this.sessions.get(deviceId);
  }

  /**
   * Get active session
   */
  private getActiveSession(): DeviceSession | undefined {
    const activeId = this.appState.getActiveDeviceId();
    return activeId ? this.sessions.get(activeId) : undefined;
  }

  // ==================== Device Control Methods ====================

  sendTouch(
    x: number,
    y: number,
    action: 'down' | 'move' | 'up',
    screenWidth: number,
    screenHeight: number
  ): void {
    this.getActiveSession()?.connection?.sendTouch(x, y, action, screenWidth, screenHeight);
  }

  sendMultiTouch(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    action: 'down' | 'move' | 'up',
    screenWidth: number,
    screenHeight: number
  ): void {
    this.getActiveSession()?.connection?.sendMultiTouch(
      x1,
      y1,
      x2,
      y2,
      action,
      screenWidth,
      screenHeight
    );
  }

  sendKeyDown(keycode: number): void {
    this.getActiveSession()?.connection?.sendKeyDown(keycode);
  }

  sendKeyUp(keycode: number): void {
    this.getActiveSession()?.connection?.sendKeyUp(keycode);
  }

  sendText(text: string): void {
    this.getActiveSession()?.connection?.sendText(text);
  }

  sendKeyWithMeta(keycode: number, action: 'down' | 'up', metastate: number): void {
    this.getActiveSession()?.connection?.sendKeyWithMeta(keycode, action, metastate);
  }

  sendScroll(x: number, y: number, deltaX: number, deltaY: number): void {
    this.getActiveSession()?.connection?.sendScroll(x, y, deltaX, deltaY);
  }

  updateDimensions(deviceId: string, width: number, height: number): void {
    const session = this.sessions.get(deviceId);
    session?.connection?.updateDimensions(width, height);
  }

  async pasteFromHost(): Promise<void> {
    await this.getActiveSession()?.connection?.pasteFromHost();
  }

  async copyToHost(): Promise<void> {
    await this.getActiveSession()?.connection?.copyToHost();
  }

  rotateDevice(): void {
    this.getActiveSession()?.connection?.rotateDevice();
  }

  expandNotificationPanel(): void {
    this.getActiveSession()?.connection?.expandNotificationPanel();
  }

  expandSettingsPanel(): void {
    this.getActiveSession()?.connection?.expandSettingsPanel();
  }

  collapsePanels(): void {
    this.getActiveSession()?.connection?.collapsePanels();
  }

  async takeScreenshot(): Promise<Buffer> {
    const session = this.getActiveSession();
    if (!session?.connection) {
      throw new Error(vscode.l10n.t('No active device'));
    }
    return session.connection.takeScreenshot();
  }

  async listCameras(): Promise<string> {
    const session = this.getActiveSession();
    if (!session?.connection) {
      throw new Error(vscode.l10n.t('No active device'));
    }
    return session.connection.listCameras();
  }

  async installApk(filePath: string): Promise<void> {
    const session = this.getActiveSession();
    if (!session?.connection) {
      throw new Error(vscode.l10n.t('No active device'));
    }
    await session.connection.installApk(filePath);
  }

  async pushFiles(filePaths: string[], destPath?: string): Promise<void> {
    const session = this.getActiveSession();
    if (!session?.connection) {
      throw new Error(vscode.l10n.t('No active device'));
    }
    await session.connection.pushFiles(filePaths, destPath);
  }

  launchApp(packageName: string): void {
    const session = this.getActiveSession();
    if (!session?.connection) {
      throw new Error(vscode.l10n.t('No active device'));
    }
    session.connection.startApp(packageName);
  }

  async getInstalledApps(
    thirdPartyOnly: boolean = false
  ): Promise<Array<{ packageName: string; label: string }>> {
    const session = this.getActiveSession();
    if (!session?.connection) {
      throw new Error(vscode.l10n.t('No active device'));
    }
    return session.connection.getInstalledApps(thirdPartyOnly);
  }

  async getDisplays(deviceId?: string): Promise<Array<{ id: number; info: string }>> {
    const session = deviceId ? this.sessions.get(deviceId) : this.getActiveSession();
    if (!session?.connection) {
      throw new Error(vscode.l10n.t('No active device'));
    }
    return session.connection.listDisplays();
  }

  // ==================== Device UI Settings ====================

  /**
   * TalkBack service identifier
   */
  private static readonly TALKBACK_SERVICE =
    'com.google.android.marvin.talkback/com.google.android.marvin.talkback.TalkBackService';

  /**
   * Get current device UI settings via ADB
   */
  async getDeviceUISettings(): Promise<DeviceUISettings> {
    const session = this.getActiveSession();
    if (!session?.connection) {
      throw new Error(vscode.l10n.t('No active device'));
    }

    const serial = session.deviceInfo.serial;
    const adbCmd = this.getAdbCommand();

    const execAdb = (args: string[]): Promise<string> => {
      return new Promise((resolve, reject) => {
        execFile(adbCmd, ['-s', serial, ...args], { timeout: 5000 }, (error, stdout, stderr) => {
          if (error) {
            reject(new Error(stderr || error.message));
          } else {
            resolve(stdout.trim());
          }
        });
      });
    };

    // Fetch all settings in parallel
    const [
      nightModeResult,
      overlayResult,
      accessibilityResult,
      fontScaleResult,
      densityResult,
      layoutBoundsResult,
      autoRotateResult,
      userRotationResult,
      stayAwakeResult,
    ] = await Promise.all([
      execAdb(['shell', 'cmd', 'uimode', 'night']).catch(() => ''),
      execAdb(['shell', 'cmd', 'overlay', 'list']).catch(() => ''),
      execAdb(['shell', 'settings', 'get', 'secure', 'enabled_accessibility_services']).catch(
        () => ''
      ),
      execAdb(['shell', 'settings', 'get', 'system', 'font_scale']).catch(() => '1.0'),
      execAdb(['shell', 'wm', 'density']).catch(() => ''),
      execAdb(['shell', 'getprop', 'debug.layout']).catch(() => ''),
      execAdb(['shell', 'settings', 'get', 'system', 'accelerometer_rotation']).catch(() => '1'),
      execAdb(['shell', 'settings', 'get', 'system', 'user_rotation']).catch(() => '0'),
      execAdb(['shell', 'settings', 'get', 'global', 'stay_on_while_plugged_in']).catch(() => '0'),
    ]);

    // Parse dark mode from "cmd uimode night" output (e.g., "Night mode: yes")
    let darkMode: DarkMode = 'auto';
    const nightModeLower = nightModeResult.toLowerCase();
    if (nightModeLower.includes('yes')) {
      darkMode = 'dark';
    } else if (nightModeLower.includes('no')) {
      darkMode = 'light';
    }

    // Parse available navigation modes from overlay list
    const availableNavigationModes: NavigationMode[] = ['threebutton']; // Always available as default
    if (overlayResult.includes('com.android.internal.systemui.navbar.gestural')) {
      availableNavigationModes.push('gestural');
    }
    if (overlayResult.includes('com.android.internal.systemui.navbar.twobutton')) {
      availableNavigationModes.push('twobutton');
    }

    // Parse current navigation mode from overlay list
    let navigationMode: NavigationMode = 'threebutton';
    if (overlayResult.includes('[x] com.android.internal.systemui.navbar.gestural')) {
      navigationMode = 'gestural';
    } else if (overlayResult.includes('[x] com.android.internal.systemui.navbar.twobutton')) {
      navigationMode = 'twobutton';
    }

    // Parse accessibility services
    const accessibilityServices = accessibilityResult.toLowerCase();
    const talkbackEnabled = accessibilityServices.includes('talkback');

    // Parse font scale
    const fontScale = parseFloat(fontScaleResult) || 1.0;

    // Parse display density
    let displayDensity = 0;
    let defaultDensity = 0;
    const densityMatch = densityResult.match(/Physical density:\s*(\d+)/);
    const overrideMatch = densityResult.match(/Override density:\s*(\d+)/);
    if (densityMatch) {
      defaultDensity = parseInt(densityMatch[1], 10);
      displayDensity = overrideMatch ? parseInt(overrideMatch[1], 10) : defaultDensity;
    }

    // Parse layout bounds
    const showLayoutBounds = layoutBoundsResult === 'true';

    // Parse orientation
    // accelerometer_rotation: 1 = auto-rotate enabled, 0 = disabled
    // user_rotation: 0 = portrait, 1 = landscape, 2 = reverse portrait, 3 = reverse landscape
    type Orientation = 'auto' | 'portrait' | 'landscape';
    let orientation: Orientation = 'auto';
    const autoRotate = autoRotateResult.trim() === '1';
    if (autoRotate) {
      orientation = 'auto';
    } else {
      const userRotation = parseInt(userRotationResult.trim(), 10) || 0;
      // 0 or 2 = portrait variants, 1 or 3 = landscape variants
      orientation = userRotation === 1 || userRotation === 3 ? 'landscape' : 'portrait';
    }

    return {
      darkMode,
      navigationMode,
      availableNavigationModes,
      talkbackEnabled,
      fontScale,
      displayDensity,
      defaultDensity,
      showLayoutBounds,
      orientation,
      stayAwake: (parseInt(stayAwakeResult.trim(), 10) || 0) > 0,
      // The display power state cannot be reliably queried; assume on at session start
      // and let the user toggle it. Cached value will be used on subsequent opens.
      screenOff: false,
    };
  }

  /**
   * Apply a single device UI setting via ADB
   */
  async applyDeviceUISetting<K extends keyof DeviceUISettings>(
    setting: K,
    value: DeviceUISettings[K]
  ): Promise<void> {
    const session = this.getActiveSession();
    if (!session?.connection) {
      throw new Error(vscode.l10n.t('No active device'));
    }

    const serial = session.deviceInfo.serial;
    const adbCmd = this.getAdbCommand();

    const execAdb = (args: string[]): Promise<string> => {
      return new Promise((resolve, reject) => {
        execFile(adbCmd, ['-s', serial, ...args], { timeout: 10000 }, (error, stdout, stderr) => {
          if (error) {
            reject(new Error(stderr || error.message));
          } else {
            resolve(stdout.trim());
          }
        });
      });
    };

    switch (setting) {
      case 'darkMode': {
        // Use cmd uimode for reliable dark mode switching
        const modeArg = value === 'light' ? 'no' : value === 'dark' ? 'yes' : 'auto';
        await execAdb(['shell', 'cmd', 'uimode', 'night', modeArg]);
        break;
      }

      case 'navigationMode': {
        // Disable all navigation overlays first
        const overlays = [
          'com.android.internal.systemui.navbar.gestural',
          'com.android.internal.systemui.navbar.twobutton',
        ];
        for (const overlay of overlays) {
          await execAdb(['shell', 'cmd', 'overlay', 'disable', '--user', 'current', overlay]).catch(
            () => {}
          );
        }
        // Three-button is the default (no overlay needed)
        // Only enable overlay for gestural or twobutton
        if (value === 'gestural') {
          await execAdb([
            'shell',
            'cmd',
            'overlay',
            'enable',
            '--user',
            'current',
            'com.android.internal.systemui.navbar.gestural',
          ]);
        } else if (value === 'twobutton') {
          await execAdb([
            'shell',
            'cmd',
            'overlay',
            'enable',
            '--user',
            'current',
            'com.android.internal.systemui.navbar.twobutton',
          ]);
        }
        break;
      }

      case 'talkbackEnabled': {
        const currentServices = await execAdb([
          'shell',
          'settings',
          'get',
          'secure',
          'enabled_accessibility_services',
        ]).catch(() => '');
        const services = currentServices
          .split(':')
          .filter((s) => s && !s.toLowerCase().includes('talkback'));
        if (value) {
          services.push(DeviceService.TALKBACK_SERVICE);
        }
        const newServices = services.join(':') || 'null';
        await execAdb([
          'shell',
          'settings',
          'put',
          'secure',
          'enabled_accessibility_services',
          newServices,
        ]);
        break;
      }

      case 'fontScale': {
        const scaleValue = String(value);
        await execAdb(['shell', 'settings', 'put', 'system', 'font_scale', scaleValue]);
        break;
      }

      case 'displayDensity': {
        const densityValue = String(value);
        await execAdb(['shell', 'wm', 'density', densityValue]);
        break;
      }

      case 'showLayoutBounds': {
        const boolValue = value ? 'true' : 'false';
        await execAdb(['shell', 'setprop', 'debug.layout', boolValue]);
        // Trigger UI refresh by broadcasting an intent
        await execAdb(['shell', 'service', 'call', 'activity', '1599295570']).catch(() => {});
        break;
      }

      case 'orientation': {
        // accelerometer_rotation: 1 = auto-rotate enabled, 0 = disabled
        // user_rotation: 0 = portrait, 1 = landscape
        if (value === 'auto') {
          // Enable auto-rotate
          await execAdb(['shell', 'settings', 'put', 'system', 'accelerometer_rotation', '1']);
        } else {
          // Set target rotation FIRST, then disable auto-rotate
          // This prevents the brief flash to wrong orientation
          const rotation = value === 'landscape' ? '1' : '0';
          await execAdb(['shell', 'settings', 'put', 'system', 'user_rotation', rotation]);
          await execAdb(['shell', 'settings', 'put', 'system', 'accelerometer_rotation', '0']);
        }
        break;
      }

      case 'stayAwake': {
        // 7 = USB | AC | Wireless (stay awake on any charger), 0 = off
        const stayValue = value ? '7' : '0';
        await execAdb([
          'shell',
          'settings',
          'put',
          'global',
          'stay_on_while_plugged_in',
          stayValue,
        ]);
        break;
      }

      case 'screenOff': {
        // Use scrcpy SET_DISPLAY_POWER control message (display off, mirroring continues)
        session.connection.setDisplayPower(!value);
        break;
      }
    }
  }

  // ==================== Session Management ====================

  /**
   * Disconnect all sessions
   */
  async disconnectAll(): Promise<void> {
    await Promise.all(
      Array.from(this.sessions.values()).map(async (s) => {
        s.isDisposed = true;
        if (s.connection) {
          await s.connection.disconnect();
        }
      })
    );
    this.sessions.clear();
    this.deviceInfoCache.clear();
    this.stopDeviceInfoRefresh();

    // Clear all devices from AppState
    this.appState.dispatch({ type: ActionType.CLEAR_ALL_DEVICES });
  }

  /**
   * Update config for future connections
   */
  updateConfig(config: ScrcpyConfig): void {
    this.config = config;
  }

  /**
   * Handle session failure (all reconnect attempts exhausted)
   */
  private handleSessionFailed(deviceId: string): void {
    const session = this.sessions.get(deviceId);
    if (!session) {
      return;
    }

    const deviceSerial = session.deviceInfo.serial;

    // Remove the failed session
    this.sessions.delete(deviceId);
    this.appState.dispatch({ type: ActionType.REMOVE_DEVICE, payload: { deviceId } });

    // Remove from known devices so auto-connect can pick it up again
    this.knownDeviceSerials.delete(deviceSerial);

    // Switch to first available session if any
    const deviceIds = this.appState.getDeviceIds();
    if (deviceIds.length > 0 && this.appState.getActiveDeviceId() === null) {
      this.switchToDevice(deviceIds[0]);
    }
  }

  // ==================== Device Monitoring ====================

  /**
   * Start monitoring for new devices using adb track-devices
   */
  async startDeviceMonitoring(): Promise<void> {
    if (this.appState.isMonitoring()) {
      return;
    }
    this.appState.dispatch({
      type: ActionType.SET_MONITORING,
      payload: { isMonitoring: true },
    });

    // Initialize known devices with currently connected sessions
    this.knownDeviceSerials.clear();
    for (const session of this.sessions.values()) {
      this.knownDeviceSerials.add(session.deviceInfo.serial);
    }

    // Mark existing ADB devices as known if we have active sessions
    if (this.sessions.size > 0) {
      const devices = await this.getAvailableDevices();
      for (const device of devices) {
        this.knownDeviceSerials.add(device.serial);
      }
    }

    // Start adb track-devices process
    this.startTrackDevices();

    // Start periodic device info refresh
    this.startDeviceInfoRefresh();
  }

  /**
   * Start the adb track-devices process
   */
  private startTrackDevices(): void {
    if (!this.appState.isMonitoring()) {
      return;
    }

    if (this.trackDevicesRestartTimeout) {
      clearTimeout(this.trackDevicesRestartTimeout);
      this.trackDevicesRestartTimeout = null;
    }

    if (this.trackDevicesProcess) {
      this.trackDevicesProcess.kill();
    }

    this.trackDevicesProcess = spawn(this.getAdbCommand(), ['track-devices']);
    let buffer = '';

    this.trackDevicesProcess.stdout?.on('data', (data: Buffer) => {
      buffer += data.toString();

      // Parse track-devices output: <4-char hex length><device list>
      while (buffer.length >= 4) {
        const lengthHex = buffer.substring(0, 4);
        const length = parseInt(lengthHex, 16);

        if (isNaN(length)) {
          buffer = '';
          break;
        }

        if (buffer.length < 4 + length) {
          break;
        }

        const deviceList = buffer.substring(4, 4 + length);
        buffer = buffer.substring(4 + length);

        this.enqueueDeviceListUpdate(deviceList);
      }
    });

    this.trackDevicesProcess.on('error', (error) => {
      console.error('track-devices error:', error);
    });

    this.trackDevicesProcess.on('close', () => {
      if (this.appState.isMonitoring()) {
        this.trackDevicesRestartTimeout = setTimeout(() => this.startTrackDevices(), 1000);
      }
    });
  }

  /**
   * Ensure device list updates are processed sequentially
   */
  private enqueueDeviceListUpdate(deviceList: string): void {
    this.deviceListUpdateChain = this.deviceListUpdateChain
      .then(async () => {
        await this.handleDeviceListUpdate(deviceList);
      })
      .catch((error) => {
        console.error('Failed to handle device list update:', error);
      });
  }

  /**
   * Handle device list update from track-devices
   */
  private async handleDeviceListUpdate(deviceList: string): Promise<void> {
    if (!this.appState.isMonitoring() || !this.config.autoConnect) {
      return;
    }

    const lines = deviceList
      .trim()
      .split('\n')
      .filter((line) => line.length > 0);
    const currentDevices: DeviceInfo[] = [];

    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 2 && parts[1] === 'device') {
        const serial = parts[0];
        if (serial.includes('_adb-tls-connect')) {
          continue;
        }
        currentDevices.push({
          serial,
          name: serial,
          model: undefined,
        });
      }
    }

    const currentSerials = new Set(currentDevices.map((d) => d.serial));

    // Find new USB devices and auto-connect
    for (const device of currentDevices) {
      if (!this.appState.isMonitoring()) {
        return;
      }
      // Skip WiFi devices for auto-connect
      if (this.isWifiDevice(device.serial)) {
        continue;
      }
      if (this.appState.isBlockedAutoConnectDevice(device.serial)) {
        continue;
      }

      if (!this.knownDeviceSerials.has(device.serial) && !this.isDeviceConnected(device.serial)) {
        // Get device model name
        try {
          const modelOutput = execFileSync(
            this.getAdbCommand(),
            ['-s', device.serial, 'shell', 'getprop', 'ro.product.model'],
            {
              timeout: 5000,
              encoding: 'utf8',
            }
          ).trim();
          device.name = modelOutput || device.serial;
          device.model = modelOutput || undefined;
        } catch {
          // Keep serial as name
        }

        // Always mark as seen to avoid repeated checks for the same plug event
        this.knownDeviceSerials.add(device.serial);

        // Only auto-connect if allowed (user has connected once before)
        if (this.appState.isAllowedAutoConnectDevice(device.serial)) {
          // Respect single-device mode
          if (!this.appState.getSettings().multiDevice && this.sessions.size > 0) {
            continue;
          }
          this.statusCallback('', vscode.l10n.t('Connecting to {0}...', device.name));

          try {
            if (!this.appState.isMonitoring()) {
              return;
            }
            await this.addDevice(device);
          } catch {
            // Failed to connect
          }
        }
      }
    }

    // Remove unplugged USB devices from known list
    for (const serial of Array.from(this.knownDeviceSerials)) {
      if (!currentSerials.has(serial) && !this.isWifiDevice(serial)) {
        this.knownDeviceSerials.delete(serial);
      }
    }
  }

  /**
   * Stop monitoring for new devices
   */
  stopDeviceMonitoring(): void {
    this.appState.dispatch({
      type: ActionType.SET_MONITORING,
      payload: { isMonitoring: false },
    });
    if (this.trackDevicesRestartTimeout) {
      clearTimeout(this.trackDevicesRestartTimeout);
      this.trackDevicesRestartTimeout = null;
    }
    if (this.trackDevicesProcess) {
      this.trackDevicesProcess.kill();
      this.trackDevicesProcess = null;
    }
    this.knownDeviceSerials.clear();
    this.stopDeviceInfoRefresh();
  }

  /**
   * Check if a device serial represents a WiFi connection
   */
  private isWifiDevice(serial: string): boolean {
    return /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d+$/.test(serial);
  }
}
