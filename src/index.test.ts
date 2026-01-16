import request from 'supertest';
import { app } from './index';
import { mockLiveKit } from '../test/mocks/livekit';
import { mockRedis } from '../test/mocks/redis';

jest.mock('redis', () => {
    const { mockRedis } = require('../test/mocks/redis');
    return {
        createClient: jest.fn().mockImplementation(() => mockRedis),
    };
});

jest.mock('livekit-server-sdk', () => {
    return {
        RoomServiceClient: jest.fn().mockImplementation(() => ({
            listRooms: jest.fn(async (names?: string[]) => mockLiveKit.listRooms(names)),
            createRoom: jest.fn(async ({ name }: { name: string }) => {
                mockLiveKit.createRoom(name);
                return { name }; // Minimal return for app
            }),
            deleteRoom: jest.fn(async (name: string) => mockLiveKit.deleteRoom(name)),
        })),
        WebhookReceiver: jest.fn().mockImplementation(() => ({
            receive: jest.fn(async (body: string, _auth: string | undefined) => {
                console.log('webhook body received: ' + body);
                return mockLiveKit.validateWebhook(body);
            }),
        })),
        AccessToken: jest.fn().mockImplementation(() => {
            return {
                addGrant: jest.fn(),
                toJwt: jest.fn().mockResolvedValue('mock-token'),
            };
        }),
    };
});

beforeEach(() => {
    mockLiveKit.reset();
    mockRedis.reset();
});

describe('Stream API', () => {
    test('Create stream', async () => {
        const res = await request(app).post('/streams').send({ name: 'test-stream' });
        expect(res.status).toBe(201);
        expect(res.body).toHaveProperty('streamId', 'test-stream');
    }, 60000);

    test('List streams', async () => {
        const res = await request(app).get('/streams');
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
    });

    test('Join stream', async () => {
        const res = await request(app)
            .post('/streams/test-stream/join')
            .send({ userId: 'test-user' });

        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('token');
        expect(typeof res.body.token).toBe('string');
    });

    test('Redis mock handles participant join', async () => {
        await request(app).post('/streams').send({ name: 'test-room' });

        const joinEvent = mockLiveKit.participantJoin('test-room', 'user1');
        const joinStr = JSON.stringify(joinEvent);

        console.log('joinEvent payload: ' + joinStr);

        const webhookRes = await request(app)
            .post('/webhook')
            .send(joinStr);

        expect(webhookRes.status).toBe(200);

        const participants = await mockRedis.sMembers('stream:participants:test-room');
        expect(participants).toContain('user1');
    });

    test('Redis mock handles participant leave', async () => {
        await request(app).post('/streams').send({ name: 'test-room' });

        // Setup: add participant first
        mockLiveKit.participantJoin('test-room', 'user1');

        const leaveEvent = mockLiveKit.participantLeave('test-room', 'user1');

        const webhookRes = await request(app)
            .post('/webhook')
            .send(JSON.stringify(leaveEvent));

        expect(webhookRes.status).toBe(200);

        const participants = await mockRedis.sMembers('stream:participants:test-room');
        expect(participants).not.toContain('user1');
    });

    test('Webhook room finish sets TTL', async () => {
        await request(app).post('/streams').send({ name: 'test-room' });

        const finishEvent = mockLiveKit.roomFinished('test-room');

        const webhookRes = await request(app)
            .post('/webhook')
            .send(JSON.stringify(finishEvent));

        expect(webhookRes.status).toBe(200);

        const ttl = await mockRedis.ttl('stream:meta:test-room');
        expect(ttl).toBeGreaterThan(0);
    });

    test('Publish triggers sub callback', async () => {
        const callback = jest.fn();
        await mockRedis.pSubscribe('updates:test-room', callback);

        await mockRedis.publish(
            'updates:test-room',
            JSON.stringify({ status: 'active' })
        );

        expect(callback).toHaveBeenCalledWith(
            expect.any(String),
            'updates:test-room'
        );
    });
});

afterAll(async () => {
    await mockRedis.quit();
});