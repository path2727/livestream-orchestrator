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

Client: index.html (list/add), room.html (view/join/leave/stop).

## Design Choices
- Redis for state: Atomic ops for concurrency, TTL for cleanup.
- SSE over WS: Simpler for one-way updates.
- Idempotency: Check existing rooms on create/delete.
- Scaling: Pub/Sub for multi-instance broadcasts.