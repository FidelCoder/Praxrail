# praxrail-core

Transport-independent schemas and contracts for Praxrail.

Use this package when you need the stable product types shared by the CLI, client, runtime, workers, and connectors.

## Install

```bash
npm install praxrail-core
```

Node.js 22.12 or newer is required.

## What belongs here

- task contracts and lifecycle state;
- actor and role schemas;
- worker registration contracts;
- product API envelopes; and
- validation helpers that do not depend on HTTP, databases, Telegram, GitHub, or model providers.

Persistence and deployment choices intentionally stay outside this package. That keeps contracts stable while the runtime migrates shared hosted state toward MongoDB/Atlas.

Source: https://github.com/FidelCoder/Praxrail
