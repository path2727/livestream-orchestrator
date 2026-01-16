import express, { Request, Response } from 'express';
import dotenv from 'dotenv';
import {
    AccessToken,
    RoomServiceClient,
    WebhookEvent,
    WebhookReceiver,
} from 'livekit-server-sdk';
import Joi from 'joi';
import client from 'prom-client';
import { createClient } from 'redis';

dotenv.config();

/* ------------------------------------------------------------------ */
/* CONFIG */
/* ------------------------------------------------------------------ */

const app = express();
const port = Number(process.env.PORT || 3000);

const livekitHost = process.env.LIVEKIT_HOST!;
const apiKey = process.env.LIVEKIT_API_KEY!;
const apiSecret = process.env.LIVEKIT_API_SECRET!;

const STREAM_TTL_SECONDS = 5 * 60;
const IDLE_TTL_SECONDS = 60;

/* ------------------------------------------------------------------ */
/* LIVEKIT */
/* ------------------------------------------------------------------ */

const roomService = new RoomServiceClient(livekitHost, apiKey, apiSecret);
const webhookReceiver = new WebhookReceiver(apiKey, apiSecret);

/* ------------------------------------------------------------------ */
/* REDIS */
/* ------------------------------------------------------------------ */

const redis = createClient({
    url: process.env.REDIS_URL || 'redis://localhost:6379',
});
await redis.connect();

const redisSub = redis.duplicate();
await redisSub.connect();

/* ------------------------------------------------------------------ */
/* EXPRESS */
/* ------------------------------------------------------------------ */

app.use(express.json());
app.use(express.static('public'));

/* ------------------------------------------------------------------ */
/* TYPES */
/* ------------------------------------------------------------------ */

interface StreamState {
    streamId: string;
    status: 'active' | 'finished';
    participants: string[];
    startedAt: string;
    endedAt?: string;
}

/* ------------------------------------------------------------------ */
/* VALIDATION */
/* ------------------------------------------------------------------ */

const createStreamSchema = Joi.object({
    name: Joi.string().required(),
});

const joinStreamSchema = Joi.object({
    userId: Joi.string().required(),
});

/* ------------------------------------------------------------------ */
/* METRICS */
/* ------------------------------------------------------------------ */

const register = new client.Registry();

const activeStreams = new client.Gauge({
    name: 'active_streams',
    help: 'Number of active streams',
});

const totalParticipants = new client.Gauge({
    name: 'total_participants',
    help: 'Total participants across streams',
});

register.registerMetric(activeStreams);
register.registerMetric(totalParticipants);

/* ------------------------------------------------------------------ */
/* REDIS HELPERS */
/* ------------------------------------------------------------------ */

async function getState(streamId: string): Promise<StreamState | null> {
    const meta = await redis.hGetAll(`stream:meta:${streamId}`);
    if (!meta.status) return null;

    const participants = await redis.sMembers(
        `stream:participants:${streamId}`,
    );

    return {
        streamId,
        status: meta.status as 'active' | 'finished',
        participants,
        startedAt: meta.started_at,
        endedAt: meta.ended_at || undefined,
    };
}

async function publishState(streamId: string) {
    const state = await getState(streamId);
    if (!state) return;

    await redis.publish(`updates:${streamId}`, JSON.stringify(state));
    await updateMetrics();
}

/* ------------------------------------------------------------------ */
/* STREAM API */
/* ------------------------------------------------------------------ */

app.post('/streams', async (req, res) => {
    const { error, value } = createStreamSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.message });

    const streamId = value.name;

    const existing = await roomService.listRooms([streamId]);
    if (existing.length > 0) {
        return res.json({ streamId });
    }

    await roomService.createRoom({
        name: streamId,
        emptyTimeout: 300,
    });

    await redis.hSet(`stream:meta:${streamId}`, {
        status: 'active',
        started_at: new Date().toISOString(),
    });

    // ensure no TTL
    await redis.persist(`stream:meta:${streamId}`);
    await redis.persist(`stream:participants:${streamId}`);

    await publishState(streamId);
    res.status(201).json({ streamId });
});

app.delete('/streams/:streamId', async (req, res) => {
    const { streamId } = req.params;

    try {
        await roomService.deleteRoom(streamId);
    } catch {}

    await redis.hSet(`stream:meta:${streamId}`, {
        status: 'finished',
        ended_at: new Date().toISOString(),
    });

    await redis.expire(`stream:meta:${streamId}`, STREAM_TTL_SECONDS);
    await redis.expire(
        `stream:participants:${streamId}`,
        STREAM_TTL_SECONDS,
    );

    await publishState(streamId);
    res.status(204).send();
});

app.post('/streams/:streamId/join', async (req, res) => {
    const { error, value } = joinStreamSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.message });

    const { streamId } = req.params;
    const { userId } = value;

    const token = new AccessToken(apiKey, apiSecret, {
        identity: userId,
    });

    token.addGrant({
        roomJoin: true,
        room: streamId,
    });

    res.json({ token: await token.toJwt() });
});

app.get('/streams/:streamId/state', async (req, res) => {
    const state = await getState(req.params.streamId);
    if (!state) return res.status(404).send();
    res.json(state);
});

/* ------------------------------------------------------------------ */
/* SSE */
/* ------------------------------------------------------------------ */

const sseClients = new Map<string, Response[]>();

app.get('/sse/:streamId/updates', async (req, res) => {
    const { streamId } = req.params;
    if (!(await getState(streamId))) return res.status(404).send();

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const clients = sseClients.get(streamId) || [];
    clients.push(res);
    sseClients.set(streamId, clients);

    res.write(': connected\n\n');

    req.on('close', () => {
        sseClients.set(
            streamId,
            (sseClients.get(streamId) || []).filter(c => c !== res),
        );
    });
});

function broadcast(streamId: string, state: StreamState) {
    for (const res of sseClients.get(streamId) || []) {
        res.write(`data: ${JSON.stringify(state)}\n\n`);
    }
}

redisSub.pSubscribe('updates:*', (message, channel) => {
    const streamId = channel.split(':')[1];
    broadcast(streamId, JSON.parse(message));
});

/* ------------------------------------------------------------------ */
/* WEBHOOK */
/* ------------------------------------------------------------------ */

app.post(
    '/webhook',
    express.raw({ type: '*/*' }),
    async (req: Request, res: Response) => {
        let event: WebhookEvent;

        try {
            const body = req.body.toString('utf8');
            event = await webhookReceiver.receive(
                body,
                req.headers.authorization,
            );
        } catch {
            return res.status(401).send();
        }

        const streamId = event.room?.name;
        if (!streamId) return res.send();

        if (event.event === 'participant_joined' && event.participant) {
            await redis.sAdd(
                `stream:participants:${streamId}`,
                event.participant.identity,
            );

            // remove idle TTL if present
            await redis.persist(`stream:meta:${streamId}`);
            await redis.persist(`stream:participants:${streamId}`);
        }

        if (event.event === 'participant_left' && event.participant) {
            await redis.sRem(
                `stream:participants:${streamId}`,
                event.participant.identity,
            );

            const remaining = await redis.sCard(
                `stream:participants:${streamId}`,
            );

            if (remaining === 0) {
                await redis.expire(`stream:meta:${streamId}`, IDLE_TTL_SECONDS);
                await redis.expire(
                    `stream:participants:${streamId}`,
                    IDLE_TTL_SECONDS,
                );
            }
        }

        if (event.event === 'room_finished') {
            await redis.hSet(`stream:meta:${streamId}`, {
                status: 'finished',
            });

            await redis.expire(`stream:meta:${streamId}`, STREAM_TTL_SECONDS);
            await redis.expire(
                `stream:participants:${streamId}`,
                STREAM_TTL_SECONDS,
            );
        }

        await publishState(streamId);
        res.send();
    },
);

/* ------------------------------------------------------------------ */
/* LIST STREAMS */
/* ------------------------------------------------------------------ */

app.get('/streams', async (_req, res) => {
    const keys = await redis.keys('stream:meta:*');
    const streams = [];

    for (const key of keys) {
        const streamId = key.replace('stream:meta:', '');
        const state = await getState(streamId);

        if (state?.status === 'active') {
            streams.push({
                streamId,
                participantCount: state.participants.length,
                startedAt: state.startedAt,
            });
        }
    }

    res.json(streams);
});

/* ------------------------------------------------------------------ */
/* METRICS */
/* ------------------------------------------------------------------ */

async function updateMetrics() {
    let active = 0;
    let participants = 0;

    for (const key of await redis.keys('stream:meta:*')) {
        const streamId = key.replace('stream:meta:', '');
        const state = await getState(streamId);

        if (state?.status === 'active') {
            active++;
            participants += state.participants.length;
        }
    }

    activeStreams.set(active);
    totalParticipants.set(participants);
}

app.get('/metrics', async (_req, res) => {
    res.setHeader('Content-Type', register.contentType);
    res.end(await register.metrics());
});

/* ------------------------------------------------------------------ */
/* START */
/* ------------------------------------------------------------------ */

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});
