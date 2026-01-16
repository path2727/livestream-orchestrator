# Livestream Orchestrator API

API to manage LiveKit rooms, track state in Redis, and broadcast updates via SSE. Handles concurrency with async/await, idempotency in endpoints, and scaling via Redis Pub/Sub.

## Architecture
- Express.js for API.
- LiveKit SDK for room management.
- Redis for state (hashes/sets with TTL for ephemerality).
- SSE for real-time updates, triggered by Pub/Sub.
- Webhooks for LiveKit events.
- Prometheus for metrics.
- Cleanup via TTL on finished/idle rooms.

## Setup
1. `npm install`
2. Copy .env.example to .env and fill values.
3. `npm run build`
4. `npm start` (or PM2 for production).

## Usage
- POST /streams {name: "room"}: Create room.
- GET /streams: List active rooms.
- POST /streams/:id/join {userId: "user"}: Get join token.
- GET /streams/:id/state: Get state.
- GET /sse/:id/updates: SSE updates.
- DELETE /streams/:id: Stop room.
- GET /metrics: Prometheus metrics.

Client: index.html (list/add rooms), room.html (view/join/leave/stop).

## Design Choices
- Redis for state: Atomic ops for concurrency, TTL for cleanup.
- SSE over WS: Simpler for one-way updates.
- Idempotency: Check existing rooms on create/delete.
- Scaling: Pub/Sub for multi-instance broadcasts.

## Tests
Run npm test to execute the Jest tests for key endpoints like creating streams and listing active rooms. This verifies basic functionality without external dependencies (mocks LiveKit calls for speed).

## .env.example
```properties
LIVEKIT_HOST=https://your-project.livekit.cloud
LIVEKIT_API_KEY=your_api_key
LIVEKIT_API_SECRET=your_api_secret
PORT=3000
REDIS_URL=redis://myusername:mypassword@my-redis-host.example.com:6379
```
## nginx setup for sse

```bash
    location /sse/ {
        proxy_pass http://<<your ip/host>>:3000;

        proxy_http_version 1.1;
        proxy_set_header Connection "";

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;

        proxy_buffering off;
        proxy_cache off;
        gzip off;

        # Prevent nginx buffering
        add_header X-Accel-Buffering no;

        # Long-lived connection
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;

        chunked_transfer_encoding on;
    }
```