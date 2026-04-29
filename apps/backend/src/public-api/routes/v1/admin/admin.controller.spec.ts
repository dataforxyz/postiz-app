// Prevent the nostr-tools ESM-only transitive dependency from being
// resolved during tests.  ApiTokenService is fully mocked below.
jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/api-tokens/api-token.service',
  () => ({ ApiTokenService: class {} })
);

// integration.manager pulls all 30+ providers (including nostr-tools, which
// ships ESM). We don't need real providers — we just need a deterministic
// list with .capabilities() returning fixture shapes.
jest.mock(
  '@gitroom/nestjs-libraries/integrations/integration.manager',
  () => {
    const make = (id: string, over: any = {}) => ({
      identifier: id,
      capabilities() {
        return {
          identifier: id,
          textMaxChars: null,
          textMaxCharsPremium: null,
          titleMaxChars: null,
          mediaKinds: [],
          maxImages: null,
          maxImageBytes: null,
          maxVideoSeconds: null,
          maxVideoSecondsDynamic: false,
          aspectRatios: [],
          allowedExtensions: [],
          flags: [],
          textFormat: 'plain',
          notes: '',
          ...over,
        };
      },
    });
    const ids = [
      'x', 'instagram', 'instagram-standalone', 'linkedin', 'linkedin-page',
      'facebook', 'tiktok', 'youtube', 'pinterest', 'reddit', 'bluesky',
      'mastodon', 'threads', 'telegram', 'discord', 'slack', 'dribbble',
      'wordpress', 'medium', 'devto', 'hashnode', 'lemmy', 'nostr',
      'wrapcast', 'vk', 'gmb', 'skool', 'mewe', 'moltbook', 'whop',
      'kick', 'twitch', 'listmonk',
    ];
    const list = ids.map((id) => {
      if (id === 'x') {
        return make(id, {
          textMaxChars: 200,
          textMaxCharsPremium: 4000,
          mediaKinds: ['text', 'image', 'video', 'gif', 'carousel'],
          allowedExtensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'mp4'],
        });
      }
      if (id === 'youtube') {
        return make(id, {
          titleMaxChars: 100,
          allowedExtensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'mp4'],
        });
      }
      // text-only providers — Postiz does not gate by extension
      if (id === 'twitch' || id === 'whop') {
        return make(id);
      }
      return make(id, {
        allowedExtensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'mp4'],
      });
    });
    return {
      socialIntegrationList: list,
      IntegrationManager: class {},
    };
  }
);

import {
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { AdminController } from './admin.controller';
import { socialIntegrationList } from '@gitroom/nestjs-libraries/integrations/integration.manager';

describe('AdminController', () => {
  const orgService = {
    adminCreateOrgAndOwner: jest.fn(),
    adminListOrgs: jest.fn(),
    adminDeleteOrg: jest.fn(),
    adminUpdateOrg: jest.fn(),
    adminAddUserToOrg: jest.fn(),
    getOrgById: jest.fn(),
  };
  const apiTokenService = {
    createToken: jest.fn(),
  };

  let controller: AdminController;

  const integrationManager = {} as any;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new AdminController(
      orgService as any,
      apiTokenService as any,
      integrationManager
    );
  });

  // ── createOrg ────────────────────────────────────────────────────────

  describe('createOrg', () => {
    it('happy path returns id/apiKey/ownerUserId', async () => {
      orgService.adminCreateOrgAndOwner.mockResolvedValue({
        id: 'org-1',
        apiKey: 'key-1',
        users: [{ userId: 'user-1', role: 'SUPERADMIN' }],
      });
      const result = await controller.createOrg({
        name: 'Acme',
        ownerEmail: 'owner@acme.test',
      });
      expect(result).toEqual({
        id: 'org-1',
        apiKey: 'key-1',
        ownerUserId: 'user-1',
      });
      expect(orgService.adminCreateOrgAndOwner).toHaveBeenCalledWith(
        'Acme',
        'owner@acme.test',
        undefined
      );
    });

    it('lowercases the email', async () => {
      orgService.adminCreateOrgAndOwner.mockResolvedValue({
        id: 'x',
        apiKey: 'k',
        users: [{ userId: 'u' }],
      });
      await controller.createOrg({
        name: 'Acme',
        ownerEmail: 'Owner@ACME.Test',
      });
      expect(orgService.adminCreateOrgAndOwner).toHaveBeenCalledWith(
        'Acme',
        'owner@acme.test',
        undefined
      );
    });

    it('rejects missing name', async () => {
      await expect(
        controller.createOrg({ ownerEmail: 'o@x.test' })
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects missing email', async () => {
      await expect(controller.createOrg({ name: 'Acme' })).rejects.toThrow(
        BadRequestException
      );
    });

    it('forwards optional password', async () => {
      orgService.adminCreateOrgAndOwner.mockResolvedValue({
        id: 'x',
        apiKey: 'k',
        users: [{ userId: 'u' }],
      });
      await controller.createOrg({
        name: 'Acme',
        ownerEmail: 'o@x.test',
        ownerPassword: 'literal-password',
      });
      expect(orgService.adminCreateOrgAndOwner).toHaveBeenCalledWith(
        'Acme',
        'o@x.test',
        'literal-password'
      );
    });
  });

  // ── listOrgs ────────────────────────────────────────────────────────

  describe('listOrgs', () => {
    it('shapes the response', async () => {
      orgService.adminListOrgs.mockResolvedValue([
        {
          id: 'a',
          name: 'A',
          createdAt: new Date('2026-04-13'),
          _count: { users: 3, Integration: 2 },
        },
        {
          id: 'b',
          name: 'B',
          createdAt: new Date('2026-04-12'),
          _count: { users: 0, Integration: 0 },
        },
      ]);
      const result = await controller.listOrgs();
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        id: 'a',
        name: 'A',
        createdAt: new Date('2026-04-13'),
        userCount: 3,
        integrationCount: 2,
      });
      expect(result[1].userCount).toBe(0);
    });
  });

  // ── deleteOrg ───────────────────────────────────────────────────────

  describe('deleteOrg', () => {
    it('succeeds silently', async () => {
      orgService.adminDeleteOrg.mockResolvedValue(undefined);
      await expect(controller.deleteOrg('org-1')).resolves.toBeUndefined();
      expect(orgService.adminDeleteOrg).toHaveBeenCalledWith('org-1');
    });

    it('maps Prisma P2025 to 404', async () => {
      const err: any = new Error('not found');
      err.code = 'P2025';
      orgService.adminDeleteOrg.mockRejectedValue(err);
      await expect(controller.deleteOrg('nope')).rejects.toThrow(
        NotFoundException
      );
    });

    it('rethrows other errors', async () => {
      orgService.adminDeleteOrg.mockRejectedValue(new Error('db down'));
      await expect(controller.deleteOrg('x')).rejects.toThrow('db down');
    });
  });

  // ── updateOrg ────────────────────────────────────────────────────────

  describe('updateOrg', () => {
    const now = new Date('2026-04-20');

    it('happy path with name only returns 200 shape', async () => {
      orgService.adminUpdateOrg.mockResolvedValue({
        id: 'org-1',
        name: 'New Name',
        description: null,
        createdAt: now,
      });
      const result = await controller.updateOrg('org-1', { name: 'New Name' });
      expect(result).toEqual({
        id: 'org-1',
        name: 'New Name',
        description: null,
        createdAt: now,
      });
      expect(orgService.adminUpdateOrg).toHaveBeenCalledWith('org-1', {
        name: 'New Name',
      });
    });

    it('happy path with description only', async () => {
      orgService.adminUpdateOrg.mockResolvedValue({
        id: 'org-2',
        name: 'Acme',
        description: 'Our tenant',
        createdAt: now,
      });
      const result = await controller.updateOrg('org-2', {
        description: 'Our tenant',
      });
      expect(orgService.adminUpdateOrg).toHaveBeenCalledWith('org-2', {
        description: 'Our tenant',
      });
      expect(result.description).toBe('Our tenant');
    });

    it('happy path with both fields', async () => {
      orgService.adminUpdateOrg.mockResolvedValue({
        id: 'org-3',
        name: 'Renamed',
        description: 'desc',
        createdAt: now,
      });
      await controller.updateOrg('org-3', {
        name: 'Renamed',
        description: 'desc',
      });
      expect(orgService.adminUpdateOrg).toHaveBeenCalledWith('org-3', {
        name: 'Renamed',
        description: 'desc',
      });
    });

    it('400 when body is empty', async () => {
      await expect(controller.updateOrg('org-1', {} as any)).rejects.toThrow(
        BadRequestException
      );
      expect(orgService.adminUpdateOrg).not.toHaveBeenCalled();
    });

    it('404 when org does not exist (Prisma P2025)', async () => {
      const err: any = new Error('not found');
      err.code = 'P2025';
      orgService.adminUpdateOrg.mockRejectedValue(err);
      await expect(
        controller.updateOrg('nope', { name: 'X' })
      ).rejects.toThrow(NotFoundException);
    });

    it('rethrows unexpected errors', async () => {
      orgService.adminUpdateOrg.mockRejectedValue(new Error('db down'));
      await expect(
        controller.updateOrg('org-1', { name: 'X' })
      ).rejects.toThrow('db down');
    });
  });

  // ── addUserToOrg ─────────────────────────────────────────────────────

  describe('addUserToOrg', () => {
    it('happy path delegates to service', async () => {
      orgService.getOrgById.mockResolvedValue({ id: 'org-1' });
      orgService.adminAddUserToOrg.mockResolvedValue({
        userId: 'user-9',
        membershipId: 'mem-2',
      });

      const result = await controller.addUserToOrg('org-1', {
        email: 'Bob@Example.Test',
        role: 'ADMIN',
      });
      expect(result).toEqual({ userId: 'user-9', membershipId: 'mem-2' });
      expect(orgService.adminAddUserToOrg).toHaveBeenCalledWith(
        'org-1',
        'bob@example.test', // lowercased
        'ADMIN',
        undefined
      );
    });

    it('defaults role to USER', async () => {
      orgService.getOrgById.mockResolvedValue({ id: 'org-1' });
      orgService.adminAddUserToOrg.mockResolvedValue({
        userId: 'u',
        membershipId: 'm',
      });
      await controller.addUserToOrg('org-1', { email: 'x@x.test' });
      expect(orgService.adminAddUserToOrg).toHaveBeenCalledWith(
        'org-1',
        'x@x.test',
        'USER',
        undefined
      );
    });

    it('404 when org does not exist', async () => {
      orgService.getOrgById.mockResolvedValue(null);
      await expect(
        controller.addUserToOrg('nope', { email: 'x@x.test' })
      ).rejects.toThrow(NotFoundException);
      expect(orgService.adminAddUserToOrg).not.toHaveBeenCalled();
    });

    it('rejects missing email', async () => {
      orgService.getOrgById.mockResolvedValue({ id: 'org-1' });
      await expect(
        controller.addUserToOrg('org-1', {} as any)
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects invalid role', async () => {
      orgService.getOrgById.mockResolvedValue({ id: 'org-1' });
      await expect(
        controller.addUserToOrg('org-1', {
          email: 'x@x.test',
          role: 'OWNER' as any,
        })
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ── mintApiToken ────────────────────────────────────────────────────

  describe('mintApiToken', () => {
    it('delegates with defaults', async () => {
      orgService.getOrgById.mockResolvedValue({ id: 'org-1' });
      apiTokenService.createToken.mockResolvedValue({
        id: 'tok-1',
        token: 'pst_raw',
      });

      const result = await controller.mintApiToken('org-1', {
        name: 'ci-token',
      });
      expect(result).toEqual({ id: 'tok-1', token: 'pst_raw' });
      expect(apiTokenService.createToken).toHaveBeenCalledWith(
        'org-1',
        'ci-token',
        ['read', 'write'],
        null
      );
    });

    it('forwards explicit permissions and integration scope', async () => {
      orgService.getOrgById.mockResolvedValue({ id: 'org-1' });
      apiTokenService.createToken.mockResolvedValue({ id: 't', token: 'pst' });
      await controller.mintApiToken('org-1', {
        name: 'dashboard',
        permissions: ['read'],
        integrationIds: ['int-a'],
      });
      expect(apiTokenService.createToken).toHaveBeenCalledWith(
        'org-1',
        'dashboard',
        ['read'],
        ['int-a']
      );
    });

    it('404 when org does not exist', async () => {
      orgService.getOrgById.mockResolvedValue(null);
      await expect(
        controller.mintApiToken('nope', { name: 'x' })
      ).rejects.toThrow(NotFoundException);
    });

    it('rejects missing name', async () => {
      orgService.getOrgById.mockResolvedValue({ id: 'org-1' });
      await expect(
        controller.mintApiToken('org-1', {} as any)
      ).rejects.toThrow(BadRequestException);
      await expect(
        controller.mintApiToken('org-1', { name: '   ' })
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ── capabilities ────────────────────────────────────────────────────

  describe('capabilities', () => {
    const SCHEMA_KEYS: Array<keyof import(
      '@gitroom/nestjs-libraries/integrations/social/social.integrations.capabilities'
    ).IntegrationCapabilities> = [
      'identifier',
      'textMaxChars',
      'textMaxCharsPremium',
      'titleMaxChars',
      'mediaKinds',
      'maxImages',
      'maxImageBytes',
      'maxVideoSeconds',
      'maxVideoSecondsDynamic',
      'aspectRatios',
      'allowedExtensions',
      'flags',
      'textFormat',
      'notes',
    ];

    it('returns a map keyed by every registered provider identifier', () => {
      const result = controller.capabilities();
      expect(Object.keys(result).length).toBeGreaterThanOrEqual(30);
      for (const id of [
        'x',
        'instagram',
        'linkedin',
        'tiktok',
        'youtube',
        'bluesky',
      ]) {
        expect(result[id]).toBeDefined();
        expect(result[id].identifier).toBe(id);
      }
    });

    it('each capability matches the schema shape', () => {
      const result = controller.capabilities();
      for (const [id, cap] of Object.entries(result)) {
        for (const k of SCHEMA_KEYS) {
          expect(cap).toHaveProperty(k);
        }
        expect(typeof cap.identifier).toBe('string');
        expect(cap.identifier).toBe(id);
        expect(Array.isArray(cap.mediaKinds)).toBe(true);
        expect(Array.isArray(cap.aspectRatios)).toBe(true);
        expect(Array.isArray(cap.allowedExtensions)).toBe(true);
        expect(Array.isArray(cap.flags)).toBe(true);
        expect(['plain', 'markdown', 'html']).toContain(cap.textFormat);
        expect(typeof cap.maxVideoSecondsDynamic).toBe('boolean');
      }
    });

    it('does not leak env / version / hostname in any capability value', () => {
      const result = controller.capabilities();
      const blob = JSON.stringify(result).toLowerCase();
      for (const banned of [
        'process.env',
        'instance_admin_key',
        'http://',
        'https://',
        'version',
      ]) {
        expect(blob.includes(banned)).toBe(false);
      }
    });

    it('GET single capability returns one provider', () => {
      const cap = controller.capability('x');
      expect(cap.identifier).toBe('x');
      expect(cap.textMaxChars).toBe(200);
      expect(cap.textMaxCharsPremium).toBe(4000);
    });

    it('exposes titleMaxChars on every provider (even when null)', () => {
      const result = controller.capabilities();
      for (const cap of Object.values(result)) {
        expect(cap).toHaveProperty('titleMaxChars');
        expect(
          cap.titleMaxChars === null || typeof cap.titleMaxChars === 'number'
        ).toBe(true);
      }
    });

    it('youtube exposes a numeric titleMaxChars (separate title field)', () => {
      const cap = controller.capability('youtube');
      expect(typeof cap.titleMaxChars).toBe('number');
      expect(cap.titleMaxChars).toBeGreaterThan(0);
    });

    it('x has titleMaxChars null (body and title share one field)', () => {
      const cap = controller.capability('x');
      expect(cap.titleMaxChars).toBeNull();
    });

    it('GET single capability with unknown id throws 404', () => {
      expect(() => controller.capability('does-not-exist')).toThrow(
        NotFoundException
      );
    });

    it('socialIntegrationList is non-empty (sanity)', () => {
      expect(socialIntegrationList.length).toBeGreaterThanOrEqual(30);
    });

    it('exposes allowedExtensions as a string array on every provider', () => {
      const result = controller.capabilities();
      for (const cap of Object.values(result)) {
        expect(cap).toHaveProperty('allowedExtensions');
        expect(cap.allowedExtensions).not.toBeNull();
        expect(cap.allowedExtensions).not.toBeUndefined();
        expect(Array.isArray(cap.allowedExtensions)).toBe(true);
        for (const ext of cap.allowedExtensions) {
          expect(typeof ext).toBe('string');
        }
      }
    });

    it('at least one provider has a non-empty allowedExtensions', () => {
      const result = controller.capabilities();
      const hasNonEmpty = Object.values(result).some(
        (cap) => cap.allowedExtensions.length > 0
      );
      expect(hasNonEmpty).toBe(true);
    });
  });
});
