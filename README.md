# CoNET Wallet Signer

CoNET Wallet Signer is a Node.js service for signing wallet requests and, where policy permits, relaying signed transactions. This repository contains the signer package and its tests. The local-first relay applies to CoNET chain ID `224422` when configured.

## Build and test

Use Node.js `22.14` or later and install dependencies from the package lockfile.

```sh
cd packages/wallet-signer
npm ci
npm run build
npm run test:unit
npm run check:no-websocket
```

The unit suite uses test fixtures and includes local RPC and fallback cases. The WebSocket check covers the signer source, compiled entries, and included startup files. See the [package documentation](packages/wallet-signer/README.md) for the existing service interface.

## CoNET relay

Set `conetRelayRpc.localUrl` to an HTTP loopback endpoint with an explicit port. Set `conetRelayRpc.publicUrl` to the CoNET public HTTPS RPC. These URLs reject credentials, query strings, and fragments. The relay rejects HTTP redirects. A successful zero value is a valid response. When an eligible error makes fallback necessary, the relay keeps the signed transaction and its identity consistent across attempts.

## Source and status

The package is based on `settleonbase/x402sdk` commit `579e224749c29054b25bc6dbde1d55d35f636ca2`. It retains the upstream package's `UNLICENSED` metadata. Public visibility does not grant an additional license.

The repository contains no production credentials, keys, wallet state, or ledgers. Keep operator configuration and test credentials outside the repository. A local build does not establish native Linux service or production acceptance.
