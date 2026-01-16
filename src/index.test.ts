import request from 'supertest';
import {WebhookEvent} from "livekit-server-sdk";  // Export app from index.ts
import { app, redis, redisSub } from './index';
import { mockLiveKit } from '../test/mocks/livekit';
import { mockRedis } from '../test/mocks/redis';

jest.mock('redis', () => {
    const { mockRedis } = require('../test/mocks/redis');
    return {
        createClient: jest.fn().mockImplementation(() => mockRedis),
    };
});

jest.mock('livekit-server-sdk', () => {
    const { mockLiveKit } = require('../test/mocks/livekit');

    return {
        RoomServiceClient: jest.fn().mockImplementation(() => ({
            listRooms: jest.fn((names?: string[]) =>
                Promise.resolve(mockLiveKit.listRooms(names)),
            ),
            createRoom: jest.fn(({ name }: { name: string }) =>
                Promise.resolve(mockLiveKit.createRoom(name)),
            ),
            deleteRoom: jest.fn((name: string) =>
                Promise.resolve(mockLiveKit.deleteRoom(name)),
            ),
        })),

        WebhookReceiver: jest.fn().mockImplementation(() => ({
            receive: jest.fn(async (body: string) => JSON.parse(body)),
        })),

        AccessToken: jest.fn().mockImplementation(
            (_key: string, _secret: string, opts: { identity: string }) => {
                let grants: any[] = [];

                return {
                    addGrant: jest.fn(grant => grants.push(grant)),
                    toJwt: jest.fn(async () =>
                        JSON.stringify({
                            identity: opts.identity,
                            grants,
                        }),
                    ),
                };
            },
        ),
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
        const res = await request(app).post('/streams/test-stream/join').send({ userId: 'test-user' });
        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('token');
        expect(typeof res.body.token).toBe('string');
    });

    test('Redis mock handles participant join', async () => {
        await request(app).post('/streams').send({ name: 'test-room' });

        // Simulate webhook participant join
        await request(app).post('/webhook').send({
            event: 'participant_joined',
            room: { name: 'test-room' },
            participant: { identity: 'user1' },
        });

        const participants = await mockRedis.sMembers('stream:participants:test-room');
        expect(participants).toContain('user1');
    });
});



afterAll(async () => {
    //await redis.quit();
    //await redisSub.quit();
    await mockRedis.quit();
});