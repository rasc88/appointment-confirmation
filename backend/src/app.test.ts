import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { app } from './app.js';

describe('app', () => {
  it('returns 404 for an unknown route', async () => {
    const response = await request(app).get('/v1/unknown');

    expect(response.status).toBe(404);
  });
});
