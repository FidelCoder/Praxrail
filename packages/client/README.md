# praxrail-client

Typed client for Praxrail local and remote runtimes.

Use this package when you want to integrate with Praxrail from another Node.js application without shelling out to `pxr`.

## Install

```bash
npm install praxrail-client
```

Node.js 22.12 or newer is required.

## Connect to a runtime

```ts
import { PraxrailClient } from 'praxrail-client';

const client = new PraxrailClient({
  endpoint: 'unix:///home/me/.local/state/praxrail/runtime.sock',
  token: process.env.PRAXRAIL_TOKEN,
});

const status = await client.runtimeStatus();
console.log(status.status);
```

Local developer clients normally connect through a mode-0600 Unix socket created by `pxr start`. Hosted runtimes use authenticated TLS endpoints and the same API contracts.

## Boundary

Do not query Praxrail persistence directly from integrations. The runtime API is the product boundary; persistence can move from PostgreSQL compatibility storage to MongoDB-backed hosted state without changing client consumers.

Source: https://github.com/FidelCoder/Praxrail
