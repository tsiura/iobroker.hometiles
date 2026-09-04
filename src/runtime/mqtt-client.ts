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
  private messageHandler: ((topic: string, payload: string) => void) | null = null;
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

  onMessage(handler: (topic: string, payload: string) => void): void {
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

    client.on('message', (topic, payload) => {
      this.messageHandler?.(topic, payload.toString('utf8'));
    });

    client.on('connect', () => {
      this.isConnected = true;
      this.log.info('[MQTT] Connected to broker');
      this.connectionHandler?.(true);
      this.flush();
    });

    client.on('reconnect', () => this.log.debug('[MQTT] Reconnecting'));

    client.on('close', () => {
      if (!this.isConnected) return;
      this.isConnected = false;
      this.log.warn('[MQTT] Connection closed');
      this.connectionHandler?.(false);
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
      this.connectionHandler?.(false);
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
