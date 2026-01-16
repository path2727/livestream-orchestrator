import request from 'supertest';
import { app } from './index';  // Export app from index.ts

describe('Stream API', () => {
    test('Create stream', async () => {
        const res = await request(app).post('/streams').send({ name: 'test-stream' });
        expect(res.status).toBe(201);
        expect(res.body).toHaveProperty('streamId', 'test-stream');
    }, 30000);

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