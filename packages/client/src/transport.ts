import http from 'node:http';
import https from 'node:https';

export interface TransportRequest {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  headers: Readonly<Record<string, string>>;
  body?: string;
  timeoutMs: number;
}

export interface TransportResponse {
  status: number;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  body: string;
}

export interface ClientTransport {
  request(input: TransportRequest): Promise<TransportResponse>;
}

function isLoopback(hostname: string): boolean {
  return ['localhost', '127.0.0.1', '::1'].includes(hostname);
}

export class NodeHttpTransport implements ClientTransport {
  constructor(
    private readonly endpoint: string,
    private readonly allowInsecureRemote = false,
  ) {}

  async request(input: TransportRequest): Promise<TransportResponse> {
    const unix = this.endpoint.startsWith('unix://');
    const endpoint = unix ? null : new URL(this.endpoint);
    if (
      endpoint?.protocol === 'http:' &&
      !isLoopback(endpoint.hostname) &&
      !this.allowInsecureRemote
    ) {
      throw new Error('Remote Praxrail endpoints require HTTPS');
    }
    if (endpoint && !['http:', 'https:'].includes(endpoint.protocol)) {
      throw new Error('Praxrail endpoint must use unix, HTTP, or HTTPS');
    }

    return new Promise<TransportResponse>((resolve, reject) => {
      const requestModule = endpoint?.protocol === 'https:' ? https : http;
      const request = requestModule.request(
        unix
          ? {
              socketPath: decodeURIComponent(
                this.endpoint.slice('unix://'.length),
              ),
              path: input.path,
              method: input.method,
              headers: input.headers,
            }
          : {
              protocol: endpoint?.protocol,
              hostname: endpoint?.hostname,
              port: endpoint?.port,
              path: input.path,
              method: input.method,
              headers: input.headers,
            },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > 2 * 1024 * 1024) {
              request.destroy(new Error('Praxrail response is too large'));
              return;
            }
            chunks.push(chunk);
          });
          response.on('end', () => {
            resolve({
              status: response.statusCode ?? 500,
              headers: response.headers,
              body: Buffer.concat(chunks).toString('utf8'),
            });
          });
        },
      );
      request.setTimeout(input.timeoutMs, () => {
        request.destroy(new Error('Praxrail request timed out'));
      });
      request.once('error', reject);
      if (input.body) request.write(input.body);
      request.end();
    });
  }
}
