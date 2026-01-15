import express, { Request, Response, NextFunction } from 'express';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';
import { RoomServiceClient, WebhookReceiver, AccessToken, WebhookEvent } from 'livekit-server-sdk';
import Joi from 'joi';
import client from 'prom-client';
import { createClient } from 'redis';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

const livekitHost = process.env.LIVEKIT_HOST!;
const apiKey = process.env.LIVEKIT_API_KEY!;
const apiSecret = process.env.LIVEKIT_API_SECRET!;
console.log("livekitHost: " + livekitHost);
console.log("apiKey: " + apiKey);

const roomService = new RoomServiceClient(livekitHost, apiKey, apiSecret);
const webhookReceiver = new WebhookReceiver(apiKey, apiSecret);

// Main Redis client for commands (get/set/keys/publish)
const redisCommands = createClient({url: process.env.REDIS_URL || 'redis://localhost:6379'});
await redisCommands.connect();

// Duplicate client for pub/sub (avoids mode conflicts)
const redisSub = redisCommands.duplicate();
await redisSub.connect();

interface StreamState {
    streamId: string;
    status: 'active' | 'finished';
    participants: string[];
    startedAt: string;
}

const sseClients = new Map<string, Response[]>();

const register = new client.Registry();
const activeStreams = new client.Gauge({name: 'active_streams', help: 'Number of active streams'});
const totalParticipants = new client.Gauge({name: 'total_participants', help: 'Total participants across streams'});
register.registerMetric(activeStreams);
register.registerMetric(totalParticipants);

interface ExtendedRequest extends Request {
    rawBody?: string;
}

// Raw body middleware for webhook debugging
// Raw body middleware for webhook debugging
app.use((req: ExtendedRequest, res: Response, next: NextFunction) => {
    if (req.path === '/webhook') {
        req.rawBody = '';
        //req.setEncoding('utf8');
        req.on('data', (chunk) => {
            req.rawBody += chunk;
        });
        req.on('end', () => {
            console.log('Webhook raw body (unparsed):', req.rawBody || 'empty');
            next();
        });
    } else {
        next();
    }
});

app.use(bodyParser.json());
app.use(express.static('public'));  // Serve static files (e.g., index.html, room.html)

const createStreamSchema = Joi.object({name: Joi.string().required()});
const joinStreamSchema = Joi.object({userId: Joi.string().required()});

// Get state from Redis
async function getState(streamId: string): Promise<StreamState | null> {
    const data = await redisCommands.get(`state:${streamId}`);
    return data ? JSON.parse(data) : null;
}

// Update state and publish
async function updateState(streamId: string, updates: Partial<StreamState>) {
    let state = await getState(streamId) || {
        streamId,
        status: 'active',
        participants: [],
        startedAt: new Date().toISOString()
    };
    state = {...state, ...updates};
    await redisCommands.set(`state:${streamId}`, JSON.stringify(state));
    await redisCommands.publish(`updates:${streamId}`, JSON.stringify(state));
    updateMetrics();
}

// Create stream
app.post('/streams', async (req: Request, res: Response) => {
    const {error, value} = createStreamSchema.validate(req.body);
    if (error) return res.status(400).json({error: error.details[0].message});

    const streamId = value.name;
    try {
        const existingRooms = await roomService.listRooms([streamId]);
        if (existingRooms.length > 0) {
            return res.status(200).json({streamId});
        }

        await roomService.createRoom({name: streamId, emptyTimeout: 300});
        await updateState(streamId, {status: 'active', participants: [], startedAt: new Date().toISOString()});
        res.status(201).json({streamId});
    } catch (err) {
        res.status(500).json({error: (err as Error).message});
    }
});

// Stop stream
app.delete('/streams/:streamId', async (req: Request, res: Response) => {
    const {streamId} = req.params;
    try {
        await roomService.deleteRoom(streamId);
        await updateState(streamId, {status: 'finished'});
        res.status(204).send();
    } catch (err) {
        if ((err as any).message.includes('room not found')) {
            return res.status(204).send();
        }
        res.status(500).json({error: (err as Error).message});
    }
});

// Join stream
app.post('/streams/:streamId/join', async (req: Request, res: Response) => {
    const {streamId} = req.params;
    console.log("/streams/" + streamId + "/join");
    const {error, value} = joinStreamSchema.validate(req.body);
    console.log("1");
    if (error) return res.status(400).json({error: error.details[0].message});
    console.log("2");

    const userId = value.userId;
    try {
        console.log("before token");
        const token = new AccessToken(apiKey, apiSecret, {identity: userId});
        console.log("token: " + token);
        token.addGrant({roomJoin: true, room: streamId});
        console.log("3");
        // res.json({token: token.toJwt()});
        res.json({ token: await token.toJwt() });  // Add await here
        console.log("4");
    } catch (err) {
        res.status(500).json({error: (err as Error).message});
    }
});

// Get stream state
app.get('/streams/:streamId/state', async (req: Request, res: Response) => {
    const {streamId} = req.params;
    const state = await getState(streamId);
    if (!state) return res.status(404).json({error: 'Stream not found'});
    res.json(state);
});

// SSE for updates
app.get('/streams/:streamId/updates', async (req: Request, res: Response) => {
    const {streamId} = req.params;
    if (!await getState(streamId)) return res.status(404).send();

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    let clients = sseClients.get(streamId) || [];
    clients.push(res);
    sseClients.set(streamId, clients);

    req.on('close', () => {
        clients = clients.filter(c => c !== res);
        sseClients.set(streamId, clients);
    });
});

// Webhook endpoint
// https://test-orch.floro.co/webhook
app.post('/webhook', async (req: Request, res: Response) => {
    console.log('Webhook received1', req.body, req.headers.authorization);
    let body: WebhookEvent;
    try {
        body = await webhookReceiver.receive(req.body, req.headers.authorization);
    } catch (err) {
        console.error("error", err);
        return res.status(401).send();
    }

    const eventType = body.event;
    const streamId = body.room?.name;

    if (!streamId) return res.status(400).send();

    console.log('Webhook received2:', eventType, 'for room:', streamId);

    let state = await getState(streamId) || {
        streamId,
        status: 'active',
        participants: [],
        startedAt: new Date().toISOString()
    };

    if (eventType === 'participant_joined' && body.participant) {
        state.participants.push(body.participant.identity);
    } else if (eventType === 'participant_left' && body.participant) {
        const participant = body.participant;
        state.participants = state.participants.filter(p => p !== participant.identity);
    } else if (eventType === 'room_finished') {
        state.status = 'finished';
    } else {
        console.warn('Unhandled webhook event:', eventType);
    }

    await updateState(streamId, state);
    res.status(200).send();
});

// List active streams
app.get('/streams', async (req: Request, res: Response) => {
    try {
        const keys = await redisCommands.keys('state:*');
        const summaries = [];
        for (const key of keys) {
            const state = await getState(key.split(':')[1]);
            if (state && state.status === 'active') {
                summaries.push({
                    streamId: state.streamId,
                    status: state.status,
                    participantCount: state.participants.length,
                    startedAt: state.startedAt,
                });
            }
        }
        res.json(summaries);
    } catch (err) {
        res.status(500).json({error: (err as Error).message});
    }
});

// Metrics
app.get('/metrics', async (req: Request, res: Response) => {
    res.setHeader('Content-Type', register.contentType);
    res.end(await register.metrics());
});

// Broadcast to SSE
function broadcastUpdate(streamId: string, state: StreamState) {
    const clients = sseClients.get(streamId) || [];
    clients.forEach(client => {
        client.write(`data: ${JSON.stringify(state)}\n\n`);
    });
}



// Update metrics from Redis
async function updateMetrics() {
    let activeCount = 0;
    let participantCount = 0;
    const keys = await redisCommands.keys('state:*');
    for (const key of keys) {
        const state = await getState(key.split(':')[1]);
        if (state?.status === 'active') {
            activeCount++;
            participantCount += state.participants.length;
        }
    }
    activeStreams.set(activeCount);
    totalParticipants.set(participantCount);
}

// Subscribe to Pub/Sub (using dedicated sub client)
redisSub.pSubscribe('updates:*', (message: string, channel: string) => {
    const streamId = channel.split(':')[1];
    const state = JSON.parse(message);
    broadcastUpdate(streamId, state);
});

// Cleanup job
setInterval(async () => {
    const keys = await redisCommands.keys('state:*');
    for (const key of keys) {
        const state = await getState(key.split(':')[1]);
        if (state?.status === 'finished') {
            await redisCommands.del(key);
            sseClients.delete(state.streamId);
        }
    }
    updateMetrics();
}, 5 * 60 * 1000);

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});

