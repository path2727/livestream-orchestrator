import request from 'supertest';
import { app } from './index';  // Export app from index.ts

jest.mock('livekit-server-sdk', () => {
    return {
        RoomServiceClient: jest.fn().mockImplementation(() => {
            return {
                listRooms: jest.fn().mockResolvedValue([]),  // Mock no existing rooms
                createRoom: jest.fn().mockResolvedValue({}),  // Mock successful creation
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