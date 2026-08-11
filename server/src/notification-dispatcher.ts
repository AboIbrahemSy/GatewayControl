import type { FastifyBaseLogger } from 'fastify';
import { SecretBox } from './crypto.js';
import type { NotificationDelivery, Store } from './types.js';

export interface NotificationDispatcherOptions {
  store: Store;
  secretBox: SecretBox;
  fetch: typeof globalThis.fetch;
  logger: FastifyBaseLogger;
  intervalMs?: number;
  offlineAfterMs?: number;
  commandStaleAfterMs?: number;
}

function message(delivery: NotificationDelivery): string {
  const details = Object.entries(delivery.payload)
    .filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value))
    .slice(0, 10)
    .map(([key, value]) => `${key}: ${String(value).slice(0, 300)}`);
  return [`Gateway Control: ${delivery.eventType}`, `Event ID: ${delivery.eventId}`, `Delivery ID: ${delivery.id}`, `Occurred: ${delivery.occurredAt}`, ...details].join('\n');
}

export class NotificationDispatcher {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  public constructor(private readonly options: NotificationDispatcherOptions) {}

  public start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.options.intervalMs ?? 5_000);
    this.timer.unref();
  }

  public stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  public async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.options.store.sweepOfflineAgents(new Date(Date.now() - (this.options.offlineAfterMs ?? 3 * 60_000)));
      await this.options.store.failStaleCommands(new Date(Date.now() - (this.options.commandStaleAfterMs ?? 24 * 60 * 60_000)));
      await this.options.store.purgeRuntimeLogResults(new Date(Date.now() - 24 * 60 * 60_000));
      const delivery = await this.options.store.claimNotificationDelivery();
      if (!delivery) return;
      await this.dispatch(delivery);
    } catch (error) {
      this.options.logger.error({ err: error }, 'Notification dispatch iteration failed.');
    } finally {
      this.running = false;
    }
  }

  private async dispatch(delivery: NotificationDelivery): Promise<void> {
    try {
      if (!await this.options.store.isNotificationDeliveryEnabled(delivery)) {
        await this.options.store.skipNotificationDelivery(delivery.id);
        return;
      }
      const secrets = await this.options.store.getNotificationSecrets();
      if (!secrets) throw new Error('Telegram notifications are not configured.');
      const response = await this.options.fetch(
        `https://api.telegram.org/bot${encodeURIComponent(this.options.secretBox.decrypt(secrets.botTokenEncrypted))}/sendMessage`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: this.options.secretBox.decrypt(secrets.groupIdEncrypted), text: message(delivery) }),
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!response.ok) throw new Error(`Telegram returned HTTP ${response.status}.`);
      await this.options.store.completeNotificationDelivery(delivery.id);
    } catch (error) {
      const attempts = delivery.attempts;
      const terminal = attempts >= 6;
      const delaySeconds = Math.min(900, 5 * (2 ** Math.max(0, attempts - 1)));
      const safeError = error instanceof Error ? error.message.slice(0, 1000) : 'Unknown delivery error.';
      await this.options.store.retryNotificationDelivery(delivery.id, safeError, delaySeconds, terminal);
    }
  }
}
