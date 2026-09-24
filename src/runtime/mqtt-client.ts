import mqtt, { type MqttClient } from 'mqtt';
import type { AdapterOptions } from '../config/options';

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug(message: string): void;
}

export interface PublishRequest {
  topic: string;
  payload: string;
  retain?: boolean;
  qos?: 0 | 1;
}

const DROP_WARN_INTERVAL_MS = 10_000;

export class HomeTilesMqttClient {
  private client: MqttClient | null = null;
  private queue: PublishRequest[] = [];
  private messageHandler: ((topic: string, payload: string, retain: boolean) => void) | null = null;
  private connectionHandler: ((connected: boolean) => void) | null = null;
  private isConnected = false;
  private dropped = 0;
  private lastDropWarnMs = 0;
  private stopping = false;

  constructor(
    private readonly options: AdapterOptions,
    private readonly log: Logger,
  ) {}

  get connected(): boolean {
    return this.isConnected;
  }

  get droppedPublishes(): number {
    return this.dropped;
  }

  get queueDepth(): number {
    return this.queue.length;
  }

  /**
   * `retain` is true only for a message the broker replays on a new
   * subscription; a live one arrives without it, however it was published
   * (MQTT 3.1.1 §3.3.1.3).
   */
  onMessage(handler: (topic: string, payload: string, retain: boolean) => void): void {
    this.messageHandler = handler;
  }

  onConnectionChange(handler: (connected: boolean) => void): void {
    this.connectionHandler = handler;
  }

  async connect(): Promise<void> {
    if (this.client) return;
    this.stopping = false;

    const protocol = this.options.brokerTls ? 'mqtts' : 'mqtt';
    const url = `${protocol}://${this.options.brokerHost}:${this.options.brokerPort}`;

    const client = mqtt.connect(url, {
      clientId: `${this.options.clientId}-${Math.random().toString(16).slice(2, 8)}`,
      username: this.options.brokerUser || undefined,
      password: this.options.brokerPassword || undefined,
      clean: true,
      reconnectPeriod: 2000,
      connectTimeout: 10_000,
      resubscribe: true,
    });
    this.client = client;

    // Every dispatch into caller code is isolated. mqtt.js emits synchronously,
    // so a throw from a handler escapes into the library's emit and takes down
    // the adapter process. The protocol parsers these handlers feed THROW by
    // design on malformed input, and that input arrives from the network, so
    // this is the difference between one rejected payload and a crash loop.
    client.on('message', (topic, payload, packet) => {
      try {
        this.messageHandler?.(topic, payload.toString('utf8'), packet.retain);
      } catch (error) {
        this.log.error(`[MQTT] Message handler failed for ${topic}: ${(error as Error).message}`);
      }
    });

    client.on('connect', () => {
      this.isConnected = true;
      this.log.info('[MQTT] Connected to broker');
      this.notifyConnection(true);
      this.flush();
    });

    client.on('reconnect', () => this.log.debug('[MQTT] Reconnecting'));

    client.on('close', () => {
      if (!this.isConnected) return;
      this.isConnected = false;
      this.log.warn('[MQTT] Connection closed');
      this.notifyConnection(false);
    });

    client.on('error', (error) => this.log.error(`[MQTT] ${error.message}`));

    await new Promise<void>((resolve) => {
      if (client.connected) return resolve();
      const done = (): void => {
        client.removeListener('connect', done);
        client.removeListener('error', done);
        resolve();
      };
      client.once('connect', done);
      client.once('error', done);
    });
  }

  async disconnect(): Promise<void> {
    const client = this.client;
    if (!client) return;
    this.stopping = true;
    this.client = null;
    await new Promise<void>((resolve) => client.end(true, {}, () => resolve()));
    if (this.isConnected) {
      this.isConnected = false;
      this.notifyConnection(false);
    }
  }

  /** Same isolation as the message path: a throwing consumer must not crash us. */
  private notifyConnection(connected: boolean): void {
    try {
      this.connectionHandler?.(connected);
    } catch (error) {
      this.log.error(`[MQTT] Connection handler failed: ${(error as Error).message}`);
    }
  }

  async subscribe(topic: string): Promise<void> {
    const client = this.client;
    if (!client) return;
    await new Promise<void>((resolve) => {
      client.subscribe(topic, { qos: 0 }, (error) => {
        if (error) this.log.error(`[MQTT] Subscribe failed for ${topic}: ${error.message}`);
        resolve();
      });
    });
  }

  async unsubscribe(topic: string): Promise<void> {
    const client = this.client;
    if (!client) return;
    await new Promise<void>((resolve) => client.unsubscribe(topic, () => resolve()));
  }

  publish(request: PublishRequest): void {
    if (this.stopping) return;

    if (this.queue.length >= this.options.maxPublishQueue) {
      // Drop the oldest: the newest value is the one the panel actually needs.
      this.queue.shift();
      this.dropped++;
      this.warnDropRateLimited();
    }
    this.queue.push(request);
    this.flush();
  }

  private warnDropRateLimited(): void {
    const now = Date.now();
    if (now - this.lastDropWarnMs < DROP_WARN_INTERVAL_MS) return;
    this.lastDropWarnMs = now;
    this.log.warn(`[MQTT] Publish queue full, dropped ${this.dropped} messages so far`);
  }

  private flush(): void {
    const client = this.client;
    if (!client || !this.isConnected) return;
    while (this.queue.length) {
      const request = this.queue.shift();
      if (!request) break;
      client.publish(request.topic, request.payload, {
        qos: request.qos ?? 0,
        retain: request.retain ?? false,
      });
    }
  }
}
