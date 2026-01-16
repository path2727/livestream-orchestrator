import request from 'supertest';
import {app} from './index';
import {mockLiveKit} from '../test/mocks/livekit';
import {mockRedis} from '../test/mocks/redis';

jest.mock('redis', () => {
    const {mockRedis} = require('../test/mocks/redis');
    return {
        createClient: jest.fn().mockImplementation(() => mockRedis),
    };
});
jest.mock('livekit-server-sdk', () => {
    return {
        RoomServiceClient: jest.fn().mockImplementation(() => ({
            listRooms: jest.fn(async (names?: string[]) => mockLiveKit.listRooms(names)),
            createRoom: jest.fn(async ({name}: { name: string }) => {
                mockLiveKit.createRoom(name);
                return {name}; // Return minimal Room for app compatibility
            }),
            deleteRoom: jest.fn(async (name: string) => mockLiveKit.deleteRoom(name)),
        })),
        WebhookReceiver: jest.fn().mockImplementation(() => ({
            receive: jest.fn(async (body: string) => JSON.parse(body)), // Simplified: Just parse, no auth validation
        })),
        AccessToken: jest.fn().mockImplementation((_apiKey: string, _apiSecret: string, {identity}: {
            identity: string
        }) => {
            const grants: any = {};
            return {
                addGrant: jest.fn((grant: any) => Object.assign(grants, grant)),
                toJwt: jest.fn(async () => 'mock-token'), // Or JSON.stringify for assertion if needed
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
        const res = await request(app).post('/streams').send({name: 'test-stream'});
        expect(res.status).toBe(201);
        expect(res.body).toHaveProperty('streamId', 'test-stream');
    }, 60000);

    test('List streams', async () => {
        const res = await request(app).get('/streams');
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
    });

    test('Join stream', async () => {
        const res = await request(app).post('/streams/test-stream/join').send({userId: 'test-user'});
        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('token');
        expect(typeof res.body.token).toBe('string');
    });

    test('Redis mock handles participant join', async () => {
        await request(app).post('/streams').send({ name: 'test-room' });

        const joinEvent = mockLiveKit.participantJoin('test-room', 'user1');

        const webhookRes = await request(app)
            .post('/webhook')
            .send(joinEvent); // Supertest will JSON.stringify the object

        expect(webhookRes.status).toBe(200); // Confirms handler processed without error

        const participants = await mockRedis.sMembers('stream:participants:test-room');
        expect(participants).toContain('user1');
    });
});


afterAll(async () => {
    //await redis.quit();
    //await redisSub.quit();
    await mockRedis.quit();
});