import { z } from 'zod';
import type { NotificationGateway } from '../../notifications/notification-service.js';

const telegramResponseSchema = z.object({
  ok: z.literal(true),
  result: z.object({ message_id: z.number().int().positive() }),
});

export class TelegramNotificationGateway implements NotificationGateway {
  constructor(private readonly botToken: string) {}

  async send(input: {
    destination: string;
    html: string;
    idempotencyKey: string;
  }): Promise<{ deliveryId: string }> {
    const response = await fetch(
      `https://api.telegram.org/bot${this.botToken}/sendMessage`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-praxrail-idempotency-key': input.idempotencyKey,
        },
        body: JSON.stringify({
          chat_id: input.destination,
          text: input.html,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok) {
      throw new Error(
        `Telegram delivery failed with status ${response.status}`,
      );
    }
    const parsed = telegramResponseSchema.parse(await response.json());
    return { deliveryId: String(parsed.result.message_id) };
  }
}
