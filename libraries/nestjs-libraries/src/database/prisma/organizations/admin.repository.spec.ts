import { OrganizationRepository } from './organization.repository';

/**
 * Tests the new admin-API helpers on OrganizationRepository: they
 * should pass through to Prisma with the expected shape and NOT
 * replicate createMaxUser's email mangling or ULTIMATE-subscription
 * side effects.
 */

describe('OrganizationRepository admin helpers', () => {
  const organization = {
    create: jest.fn(),
    findMany: jest.fn(),
    delete: jest.fn(),
  };
  const userOrg = {
    findFirst: jest.fn(),
    create: jest.fn(),
  };
  const user = {
    findFirst: jest.fn(),
    create: jest.fn(),
  };

  const mkRepo = () =>
    new OrganizationRepository(
      { model: { organization } } as any,
      { model: { userOrganization: userOrg } } as any,
      { model: { user } } as any
    );

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ── adminCreateOrgAndOwner ────────────────────────────────────────

  describe('adminCreateOrgAndOwner', () => {
    it('stores email as-is (no +saasName mangling)', async () => {
      organization.create.mockResolvedValue({
        id: 'org-1',
        apiKey: 'k',
        users: [{ userId: 'u', role: 'SUPERADMIN' }],
      });

      await mkRepo().adminCreateOrgAndOwner('Acme', 'owner@acme.test');

      const args = organization.create.mock.calls[0][0];
      expect(args.data.users.create.user.create.email).toBe(
        'owner@acme.test'
      );
      // Must NOT contain the '+saas' marker that createMaxUser uses
      expect(args.data.users.create.user.create.email).not.toContain('+');
    });

    it('does not attach a subscription', async () => {
      organization.create.mockResolvedValue({
        id: 'org-1',
        apiKey: 'k',
        users: [{ userId: 'u' }],
      });
      await mkRepo().adminCreateOrgAndOwner('Acme', 'o@x.test');
      const args = organization.create.mock.calls[0][0];
      expect(args.data.subscription).toBeUndefined();
    });

    it('owner role is SUPERADMIN', async () => {
      organization.create.mockResolvedValue({
        id: 'x',
        apiKey: 'k',
        users: [{ userId: 'u' }],
      });
      await mkRepo().adminCreateOrgAndOwner('Acme', 'o@x.test');
      const args = organization.create.mock.calls[0][0];
      expect(args.data.users.create.role).toBe('SUPERADMIN');
    });

    it('forwards explicit owner password', async () => {
      organization.create.mockResolvedValue({
        id: 'x',
        apiKey: 'k',
        users: [{ userId: 'u' }],
      });
      await mkRepo().adminCreateOrgAndOwner('Acme', 'o@x.test', 'literal');
      const args = organization.create.mock.calls[0][0];
      // Password is hashed, but it's passed to AuthService.hashPassword
      // which is deterministic wrt input — just confirm a hashed value
      // exists rather than asserting equality.
      expect(args.data.users.create.user.create.password).toBeTruthy();
      expect(args.data.users.create.user.create.password).not.toBe('literal');
    });
  });

  // ── adminListOrgs ──────────────────────────────────────────────────

  describe('adminListOrgs', () => {
    it('orders by createdAt desc and selects counts', async () => {
      organization.findMany.mockResolvedValue([]);
      await mkRepo().adminListOrgs();
      const args = organization.findMany.mock.calls[0][0];
      expect(args.orderBy).toEqual({ createdAt: 'desc' });
      expect(args.select._count.select.users).toBe(true);
      expect(args.select._count.select.Integration).toBe(true);
    });
  });

  // ── adminDeleteOrg ─────────────────────────────────────────────────

  describe('adminDeleteOrg', () => {
    it('passes the id through to prisma.delete', async () => {
      organization.delete.mockResolvedValue({});
      await mkRepo().adminDeleteOrg('org-xyz');
      expect(organization.delete).toHaveBeenCalledWith({
        where: { id: 'org-xyz' },
      });
    });
  });

  // ── adminFindOrCreateUser + adminAddUserToOrg ─────────────────────

  describe('adminFindOrCreateUser', () => {
    it('returns existing LOCAL user without creating', async () => {
      user.findFirst.mockResolvedValue({ id: 'u-1', email: 'x@x.test' });
      const result = await mkRepo().adminFindOrCreateUser('x@x.test');
      expect(result).toEqual({ id: 'u-1', email: 'x@x.test' });
      expect(user.create).not.toHaveBeenCalled();
    });

    it('creates a new LOCAL user when none exists', async () => {
      user.findFirst.mockResolvedValue(null);
      user.create.mockResolvedValue({ id: 'u-new' });
      await mkRepo().adminFindOrCreateUser('fresh@x.test');
      expect(user.create).toHaveBeenCalledTimes(1);
      const args = user.create.mock.calls[0][0];
      expect(args.data.email).toBe('fresh@x.test');
      expect(args.data.providerName).toBe('LOCAL');
      expect(args.data.activated).toBe(true);
    });

    it('lookup is scoped to providerName=LOCAL', async () => {
      user.findFirst.mockResolvedValue({ id: 'u', email: 'x@x.test' });
      await mkRepo().adminFindOrCreateUser('x@x.test');
      const args = user.findFirst.mock.calls[0][0];
      expect(args.where.providerName).toBe('LOCAL');
    });
  });

  describe('adminAddUserToOrg', () => {
    it('returns existing membership if present (idempotent)', async () => {
      userOrg.findFirst.mockResolvedValue({
        id: 'mem-existing',
        organizationId: 'org-1',
        userId: 'u-1',
      });
      const result = await mkRepo().adminAddUserToOrg(
        'org-1',
        'u-1',
        'USER'
      );
      expect(result.id).toBe('mem-existing');
      expect(userOrg.create).not.toHaveBeenCalled();
    });

    it('creates new membership with requested role', async () => {
      userOrg.findFirst.mockResolvedValue(null);
      userOrg.create.mockResolvedValue({ id: 'mem-new' });
      await mkRepo().adminAddUserToOrg('org-1', 'u-1', 'ADMIN');
      const args = userOrg.create.mock.calls[0][0];
      expect(args.data).toMatchObject({
        organizationId: 'org-1',
        userId: 'u-1',
        role: 'ADMIN',
        disabled: false,
      });
    });
  });
});
