import { z } from 'zod';
import type { ChannelGateway } from './channel-delivery-service.js';

const providerResponseSchema = z.object({
  id: z.string().min(1).max(500),
  threadId: z.string().min(1).max(500).optional(),
});

export class EmailProviderGateway implements ChannelGateway {
  private readonly endpoint: URL;

  constructor(
    endpoint: string,
    private readonly apiKey: string,
    private readonly from: string,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {
    this.endpoint = new URL(endpoint);
    if (this.endpoint.protocol !== 'https:') {
      throw new Error('Email provider endpoint requires HTTPS');
    }
    if (apiKey.length < 16)
      throw new Error('Email provider API key is invalid');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(from)) {
      throw new Error('Email sender address is invalid');
    }
  }

  async send(input: {
    destination: string;
    subject: string;
    text: string;
    html: string;
    idempotencyKey: string;
    threadReference?: string | undefined;
  }): Promise<{ deliveryId: string; threadReference?: string | undefined }> {
    const response = await this.fetchImplementation(this.endpoint, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
        'idempotency-key': input.idempotencyKey,
      },
      body: JSON.stringify({
        from: this.from,
        to: input.destination,
        subject: input.subject,
        text: input.text,
        html: input.html,
        ...(input.threadReference
          ? { threadReference: input.threadReference }
          : {}),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new Error(
        `Email provider rejected delivery with status ${response.status}`,
      );
    }
    const result = providerResponseSchema.parse(await response.json());
    return {
      deliveryId: result.id,
      ...(result.threadId ? { threadReference: result.threadId } : {}),
    };
  }
}
