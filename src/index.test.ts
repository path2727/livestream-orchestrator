import request from 'supertest';
import { app } from './index';
import {WebhookEvent} from "livekit-server-sdk";  // Export app from index.ts
import { redis, redisSub } from './index';
jest.mock('livekit-server-sdk', () => {
    return {
        RoomServiceClient: jest.fn().mockImplementation(() => {
            return {
                listRooms: jest.fn().mockResolvedValue([]),  // Mock no existing rooms
                createRoom: jest.fn().mockResolvedValue({}),  // Mock successful creation
            };
        }),
        WebhookReceiver: jest.fn().mockImplementation(() => {
            return {
                receive: jest.fn().mockImplementation(async (body: string, auth: string | undefined) => {
                    // Mock successful verification and return a parsed event
                    const mockEvent: WebhookEvent = JSON.parse(body);  // Simulate parsing
                    return mockEvent;
                }),
            };
        }),
        AccessToken: jest.fn().mockImplementation(() => {
            return {
                addGrant: jest.fn(),
                toJwt: jest.fn().mockResolvedValue('mock-token'),
            };
        }),
    };
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
});

afterAll(async () => {
    await redis.quit();
    await redisSub.quit();

});