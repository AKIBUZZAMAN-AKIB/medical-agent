const express = require('express');
const request = require('supertest');

jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  Tokenizer: {
    getTokenCount: jest.fn().mockReturnValue(5),
  },
  generateCheckAccess: jest.fn(() => (req, res, next) => next()),
}));

jest.mock('librechat-data-provider', () => ({
  ...jest.requireActual('librechat-data-provider'),
}));

jest.mock('~/models', () => ({
  getAllUserMemories: jest.fn(),
  getUserMemories: jest.fn(),
  toggleUserMemories: jest.fn(),
  getRoleByName: jest.fn(),
  createMemory: jest.fn(),
  deleteMemory: jest.fn(),
  setMemory: jest.fn(),
  getAgents: jest.fn(),
  getUserProfiles: jest.fn(),
  deleteProfile: jest.fn(),
}));

jest.mock('~/server/services/PermissionService', () => ({
  findAccessibleResources: jest.fn().mockResolvedValue([]),
}));

jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (req, res, next) => next(),
  configMiddleware: (req, res, next) => next(),
}));

const { createMemory, getUserMemories, setMemory } = require('~/models');

describe('memories routes', () => {
  let app;

  beforeAll(() => {
    const memoriesRouter = require('../memories');

    app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.user = { id: 'user-1', role: 'USER' };
      next();
    });
    app.use('/api/memories', memoriesRouter);
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /', () => {
    it('returns 400 when the key contains invalid characters', async () => {
      const response = await request(app)
        .post('/api/memories')
        .send({ key: 'My Key!', value: 'some value' });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('lowercase letters and underscores');
      expect(createMemory).not.toHaveBeenCalled();
    });

    it('returns 400 when the key contains uppercase letters', async () => {
      const response = await request(app)
        .post('/api/memories')
        .send({ key: 'myKey', value: 'some value' });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('lowercase letters and underscores');
      expect(createMemory).not.toHaveBeenCalled();
    });

    it('creates a memory when the key is valid', async () => {
      getUserMemories
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ key: 'my_key', value: 'some value', tokenCount: 5 }]);
      createMemory.mockResolvedValue({ ok: true });

      const response = await request(app)
        .post('/api/memories')
        .send({ key: 'my_key', value: 'some value' });

      expect(response.status).toBe(201);
      expect(response.body.created).toBe(true);
      expect(createMemory).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-1', key: 'my_key' }),
      );
    });
  });

  describe('PATCH /:key', () => {
    it('returns 400 when renaming to a key with invalid characters', async () => {
      const response = await request(app)
        .patch('/api/memories/my_key')
        .send({ key: 'New Key', value: 'updated value' });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('lowercase letters and underscores');
      expect(createMemory).not.toHaveBeenCalled();
    });

    it('returns 400 when the key is not a string', async () => {
      const response = await request(app)
        .patch('/api/memories/my_key')
        .send({ key: 123, value: 'updated value' });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Key must be a string.');
      expect(setMemory).not.toHaveBeenCalled();
      expect(createMemory).not.toHaveBeenCalled();
    });

    it('rejects a whitespace-only rename instead of updating the existing memory', async () => {
      getUserMemories.mockResolvedValue([{ key: 'my_key', value: 'old value', tokenCount: 5 }]);
      setMemory.mockResolvedValue({ ok: true });

      const response = await request(app)
        .patch('/api/memories/my_key')
        .send({ key: ' \t\n ', value: 'updated value' });

      expect(response.status).toBe(400);
      expect(setMemory).not.toHaveBeenCalled();
      expect(createMemory).not.toHaveBeenCalled();
    });

    it('trims the new key before validating and renaming', async () => {
      const { deleteMemory } = require('~/models');
      getUserMemories
        .mockResolvedValueOnce([{ key: 'my_key', value: 'old value', tokenCount: 5 }])
        .mockResolvedValueOnce([{ key: 'new_key', value: 'updated value', tokenCount: 5 }]);
      createMemory.mockResolvedValue({ ok: true });
      deleteMemory.mockResolvedValue({ ok: true });

      const response = await request(app)
        .patch('/api/memories/my_key')
        .send({ key: '  new_key  ', value: 'updated value' });

      expect(response.status).toBe(200);
      expect(createMemory).toHaveBeenCalledWith(expect.objectContaining({ key: 'new_key' }));
      expect(deleteMemory).toHaveBeenCalledWith(expect.objectContaining({ key: 'my_key' }));
    });

    it('updates the value when the key is unchanged', async () => {
      getUserMemories
        .mockResolvedValueOnce([{ key: 'my_key', value: 'old value', tokenCount: 5 }])
        .mockResolvedValueOnce([{ key: 'my_key', value: 'updated value', tokenCount: 5 }]);
      setMemory.mockResolvedValue({ ok: true });

      const response = await request(app)
        .patch('/api/memories/my_key')
        .send({ value: 'updated value' });

      expect(response.status).toBe(200);
      expect(response.body.updated).toBe(true);
      expect(setMemory).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-1', key: 'my_key' }),
      );
    });
  });

  describe('per-person records', () => {
    const { getUserProfiles, deleteProfile, deleteMemory } = require('~/models');

    it('lists the people on file with what each record holds', async () => {
      getUserProfiles.mockResolvedValue([
        { profileId: undefined, name: 'Danny', isSelf: true, factCount: 3, tokenCount: 30 },
        {
          profileId: 'father',
          name: 'father',
          relationship: 'parent',
          factCount: 1,
          tokenCount: 8,
        },
      ]);

      const response = await request(app).get('/api/memories/profiles');

      expect(response.status).toBe(200);
      expect(response.body.profiles).toHaveLength(2);
      expect(response.body.profiles[0]).toEqual(
        expect.objectContaining({ isSelf: true, factCount: 3 }),
      );
      expect(getUserProfiles).toHaveBeenCalledWith('user-1');
    });

    it("deletes a person's record and reports how much went with it", async () => {
      deleteProfile.mockResolvedValue({ ok: true, deletedMemories: 4 });

      const response = await request(app).delete('/api/memories/profiles/father');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ deleted: true, deletedMemories: 4 });
      expect(deleteProfile).toHaveBeenCalledWith({ userId: 'user-1', profileId: 'father' });
    });

    it('answers 404 for a record that does not exist rather than reporting success', async () => {
      deleteProfile.mockResolvedValue({ ok: false });

      const response = await request(app).delete('/api/memories/profiles/nobody');

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Profile not found.');
    });

    it("scopes a write to the person it names and returns that person's created memory", async () => {
      let stored = [];
      getUserMemories.mockImplementation(async ({ profileId }) =>
        profileId === 'father' ? stored : [{ key: 'condition', value: 'Wrong partition!' }],
      );
      createMemory.mockImplementation(async (doc) => {
        stored = [
          {
            key: doc.key,
            value: doc.value,
            profileId: doc.profileId,
            agentId: doc.agentId,
            tokenCount: doc.tokenCount,
          },
        ];
        return { ok: true };
      });

      const response = await request(app)
        .post('/api/memories')
        .send({ key: 'condition', value: 'Has asthma', profileId: 'father' });

      expect(response.status).toBe(201);
      expect(createMemory).toHaveBeenCalledWith(expect.objectContaining({ profileId: 'father' }));
      expect(getUserMemories).toHaveBeenLastCalledWith(
        expect.objectContaining({ userId: 'user-1', profileId: 'father' }),
      );
      expect(response.body).toEqual({
        created: true,
        memory: expect.objectContaining({
          key: 'condition',
          value: 'Has asthma',
          profileId: 'father',
        }),
      });
    });

    it('scopes a delete to the person it names', async () => {
      deleteMemory.mockResolvedValue({ ok: true });

      await request(app).delete('/api/memories/condition?profileId=father');

      expect(deleteMemory).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-1', key: 'condition', profileId: 'father' }),
      );
    });

    it('leaves the personal partition alone when no person is named', async () => {
      deleteMemory.mockResolvedValue({ ok: true });

      await request(app).delete('/api/memories/condition');

      expect(deleteMemory).toHaveBeenCalledWith(expect.objectContaining({ profileId: undefined }));
    });

    it('labels each fact with the person it is about', async () => {
      const { getAllUserMemories } = require('~/models');
      getAllUserMemories.mockResolvedValue([
        { key: 'condition', value: 'Has asthma', profileId: 'father', tokenCount: 5 },
        { key: 'allergy', value: 'Penicillin', tokenCount: 4 },
      ]);
      getUserProfiles.mockResolvedValue([{ profileId: 'father', name: 'My father' }]);

      const response = await request(app).get('/api/memories');

      expect(response.status).toBe(200);
      const byKey = Object.fromEntries(
        response.body.memories.map((memory) => [memory.key, memory]),
      );
      expect(byKey.condition.profileName).toBe('My father');
      /** The user's own facts carry no name, so the UI never implies a third party. */
      expect(byKey.allergy.profileName).toBeUndefined();
    });
  });
});
