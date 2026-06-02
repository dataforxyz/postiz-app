import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { Role, ShortLinkPreference, SubscriptionTier } from '@prisma/client';
import { Injectable } from '@nestjs/common';
import { AuthService } from '@gitroom/helpers/auth/auth.service';
import { CreateOrgUserDto } from '@gitroom/nestjs-libraries/dtos/auth/create.org.user.dto';
import { makeId } from '@gitroom/nestjs-libraries/services/make.is';

@Injectable()
export class OrganizationRepository {
  constructor(
    private _organization: PrismaRepository<'organization'>,
    private _userOrg: PrismaRepository<'userOrganization'>,
    private _user: PrismaRepository<'user'>
  ) {}

  createMaxUser(id: string, name: string, saasName: string, email: string) {
    return this._organization.model.organization.create({
      select: {
        id: true,
        apiKey: true,
      },
      data: {
        name: name ? `${name}###${id}` : `Unnamed User###${id}`,
        apiKey: AuthService.fixedEncryption(makeId(20)),
        isTrailing: false,
        subscription: {
          create: {
            totalChannels: 1000000,
            subscriptionTier: 'ULTIMATE',
            isLifetime: true,
            period: 'YEARLY',
          },
        },
        users: {
          create: {
            role: Role.SUPERADMIN,
            user: {
              create: {
                activated: true,
                email: email
                  ? email.split('@').join(`+${saasName}@`)
                  : `${saasName}+` + makeId(10) + '@postiz.com',
                name: name ? `${name}###${id}` : `Unnamed User###${id}`,
                providerName: 'LOCAL',
                password: AuthService.hashPassword(makeId(500)),
                timezone: 0,
              },
            },
          },
        },
      },
    });
  }

  getOrgByApiKey(api: string) {
    return this._organization.model.organization.findFirst({
      where: {
        apiKey: api,
      },
      include: {
        subscription: {
          select: {
            subscriptionTier: true,
            totalChannels: true,
            isLifetime: true,
          },
        },
      },
    });
  }

  getCount() {
    return this._organization.model.organization.count();
  }

  getUserOrg(id: string) {
    return this._userOrg.model.userOrganization.findFirst({
      where: {
        id,
      },
      select: {
        user: true,
        organization: {
          include: {
            users: {
              select: {
                id: true,
                disabled: true,
                role: true,
                userId: true,
              },
            },
            subscription: {
              select: {
                subscriptionTier: true,
                totalChannels: true,
                isLifetime: true,
              },
            },
          },
        },
      },
    });
  }

  getImpersonateUser(name: string) {
    return this._userOrg.model.userOrganization.findMany({
      where: {
        OR: [
          {
            organizationId: {
              contains: name,
            },
          },
          {
            user: {
              OR: [
                {
                  name: {
                    contains: name,
                  },
                },
                {
                  email: {
                    contains: name,
                  },
                },
                {
                  id: {
                    contains: name,
                  },
                },
              ],
            },
          },
        ],
      },
      select: {
        id: true,
        organization: {
          select: {
            id: true,
          },
        },
        user: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
    });
  }

  updateApiKey(orgId: string) {
    return this._organization.model.organization.update({
      where: {
        id: orgId,
      },
      data: {
        apiKey: AuthService.fixedEncryption(makeId(20)),
      },
    });
  }

  async getOrgsByUserId(userId: string) {
    return this._organization.model.organization.findMany({
      where: {
        users: {
          some: {
            userId,
          },
        },
      },
      include: {
        users: {
          where: {
            userId,
          },
          select: {
            disabled: true,
            role: true,
          },
        },
        subscription: {
          select: {
            subscriptionTier: true,
            totalChannels: true,
            isLifetime: true,
            createdAt: true,
          },
        },
      },
    });
  }

  async getOrgById(id: string) {
    return this._organization.model.organization.findUnique({
      where: {
        id,
      },
      include: {
        subscription: {
          select: {
            subscriptionTier: true,
            totalChannels: true,
            isLifetime: true,
          },
        },
      },
    });
  }

  async addUserToOrg(
    userId: string,
    id: string,
    orgId: string,
    role: 'USER' | 'ADMIN'
  ) {
    const checkIfInviteExists = await this._user.model.user.findFirst({
      where: {
        inviteId: id,
      },
    });

    if (checkIfInviteExists) {
      return false;
    }

    const checkForSubscription =
      await this._organization.model.organization.findFirst({
        where: {
          id: orgId,
        },
        select: {
          subscription: true,
        },
      });

    if (
      process.env.STRIPE_PUBLISHABLE_KEY &&
      checkForSubscription?.subscription?.subscriptionTier ===
        SubscriptionTier.STANDARD
    ) {
      return false;
    }

    const create = await this._userOrg.model.userOrganization.create({
      data: {
        role,
        userId,
        organizationId: orgId,
      },
    });

    await this._user.model.user.update({
      where: {
        id: userId,
      },
      data: {
        inviteId: id,
      },
    });

    return create;
  }

  async createOrgAndUser(
    body: Omit<CreateOrgUserDto, 'providerToken'> & { providerId?: string },
    hasEmail: boolean,
    ip: string,
    userAgent: string
  ) {
    return this._organization.model.organization.create({
      data: {
        name: body.company,
        apiKey: AuthService.fixedEncryption(makeId(20)),
        allowTrial: true,
        isTrailing: true,
        users: {
          create: {
            role: Role.SUPERADMIN,
            user: {
              create: {
                activated: body.provider !== 'LOCAL' || !hasEmail,
                email: body.email,
                password: body.password
                  ? AuthService.hashPassword(body.password)
                  : '',
                providerName: body.provider,
                providerId: body.providerId || '',
                timezone: 0,
                ip,
                agent: userAgent,
              },
            },
          },
        },
      },
      select: {
        id: true,
        users: {
          select: {
            user: true,
          },
        },
      },
    });
  }

  getOrgByCustomerId(customerId: string) {
    return this._organization.model.organization.findFirst({
      where: {
        paymentId: customerId,
      },
    });
  }

  async setStreak(organizationId: string, type: 'start' | 'end') {
    try {
      await this._organization.model.organization.update({
        where: {
          id: organizationId,
          ...(type === 'start'
            ? {
                streakSince: null,
              }
            : {}),
        },
        data: {
          ...(type === 'end' ? { streakSince: null } : {}),
          ...(type === 'start' ? { streakSince: new Date() } : {}),
        },
      });
    } catch (err) {}
  }

  async getTeam(orgId: string) {
    return this._organization.model.organization.findUnique({
      where: {
        id: orgId,
      },
      select: {
        users: {
          select: {
            role: true,
            user: {
              select: {
                email: true,
                id: true,
                sendSuccessEmails: true,
                sendFailureEmails: true,
                sendStreakEmails: true,
              },
            },
          },
        },
      },
    });
  }

  getAllUsersOrgs(orgId: string) {
    return this._organization.model.organization.findUnique({
      where: {
        id: orgId,
      },
      select: {
        users: {
          select: {
            user: {
              select: {
                email: true,
                id: true,
                sendSuccessEmails: true,
                sendFailureEmails: true,
              },
            },
          },
        },
      },
    });
  }

  async deleteTeamMember(orgId: string, userId: string) {
    return this._userOrg.model.userOrganization.delete({
      where: {
        userId_organizationId: {
          userId,
          organizationId: orgId,
        },
      },
    });
  }

  disableOrEnableNonSuperAdminUsers(orgId: string, disable: boolean) {
    return this._userOrg.model.userOrganization.updateMany({
      where: {
        organizationId: orgId,
        role: {
          not: Role.SUPERADMIN,
        },
      },
      data: {
        disabled: disable,
      },
    });
  }

  getShortlinkPreference(orgId: string) {
    return this._organization.model.organization.findUnique({
      where: {
        id: orgId,
      },
      select: {
        shortlink: true,
      },
    });
  }

  updateShortlinkPreference(orgId: string, shortlink: ShortLinkPreference) {
    return this._organization.model.organization.update({
      where: {
        id: orgId,
      },
      data: {
        shortlink,
      },
    });
  }

  // ── Instance-admin API helpers ────────────────────────────────────────
  //
  // These methods back the /public/v1/admin/* surface. Unlike
  // createMaxUser (SaaS reseller path), they do NOT:
  //  - Mangle the email (no `email+saas@domain`)
  //  - Auto-provision an ULTIMATE subscription
  //  - Require an external user id / saasName
  // They behave like a normal sign-up would if one existed as an API,
  // letting operator tooling provision tenants cleanly.

  async adminCreateOrgAndOwner(
    name: string,
    ownerEmail: string,
    ownerPassword?: string
  ) {
    const rawPassword = ownerPassword || makeId(24);
    return this._organization.model.organization.create({
      select: {
        id: true,
        apiKey: true,
        users: {
          select: {
            userId: true,
            role: true,
          },
        },
      },
      data: {
        name,
        apiKey: AuthService.fixedEncryption(makeId(20)),
        isTrailing: false,
        users: {
          create: {
            role: Role.SUPERADMIN,
            user: {
              create: {
                activated: true,
                email: ownerEmail,
                name: ownerEmail.split('@')[0],
                providerName: 'LOCAL',
                password: AuthService.hashPassword(rawPassword),
                timezone: 0,
              },
            },
          },
        },
      },
    });
  }

  async adminListOrgs() {
    return this._organization.model.organization.findMany({
      select: {
        id: true,
        name: true,
        createdAt: true,
        apiKey: true,
        _count: {
          select: {
            users: true,
            Integration: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async adminDeleteOrg(id: string) {
    // Prisma cascade rules handle most dependent rows; any that lack
    // cascade should be explicitly cleared by the caller before this.
    return this._organization.model.organization.delete({
      where: { id },
    });
  }

  async adminUpdateOrg(
    id: string,
    updates: { name?: string; description?: string }
  ) {
    return this._organization.model.organization.update({
      where: { id },
      data: updates,
      select: {
        id: true,
        name: true,
        description: true,
        createdAt: true,
      },
    });
  }

  async adminFindOrCreateUser(email: string, password?: string) {
    const existing = await this._user.model.user.findFirst({
      where: { providerName: 'LOCAL', email },
    });
    if (existing) return existing;

    const rawPassword = password || makeId(24);
    return this._user.model.user.create({
      data: {
        activated: true,
        email,
        name: email.split('@')[0],
        providerName: 'LOCAL',
        password: AuthService.hashPassword(rawPassword),
        timezone: 0,
      },
    });
  }

  async adminAddUserToOrg(
    orgId: string,
    userId: string,
    role: 'USER' | 'ADMIN'
  ) {
    // Idempotent: returning the existing membership if already present.
    const existing = await this._userOrg.model.userOrganization.findFirst({
      where: { organizationId: orgId, userId },
    });
    if (existing) return existing;

    return this._userOrg.model.userOrganization.create({
      data: {
        userId,
        organizationId: orgId,
        role: role as Role,
        disabled: false,
      },
    });
  }

  async adminRemoveUserFromOrg(orgId: string, userId: string) {
    // Returns the deleted membership or throws Prisma P2025 if not found.
    return this._userOrg.model.userOrganization.delete({
      where: {
        userId_organizationId: {
          userId,
          organizationId: orgId,
        },
      },
    });
  }

  async adminUpdateUser(
    userId: string,
    updates: { email?: string; role?: Role },
    orgId?: string
  ) {
    // Update the User table fields (email).
    if (updates.email !== undefined) {
      await this._user.model.user.update({
        where: { id: userId },
        data: { email: updates.email },
      });
    }
    // Update role in the membership row (scoped to orgId if provided).
    if (updates.role !== undefined && orgId) {
      await this._userOrg.model.userOrganization.update({
        where: {
          userId_organizationId: { userId, organizationId: orgId },
        },
        data: { role: updates.role },
      });
    }
    return this._user.model.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        createdAt: true,
        organizations: {
          select: {
            role: true,
            organizationId: true,
            createdAt: true,
          },
        },
      },
    });
  }

  async adminListOrgUsers(orgId: string) {
    const memberships = await this._userOrg.model.userOrganization.findMany({
      where: { organizationId: orgId },
      select: {
        role: true,
        createdAt: true,
        user: {
          select: {
            id: true,
            email: true,
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
    return memberships.map((m) => ({
      id: m.user.id,
      email: m.user.email,
      role: m.role as string,
      addedAt: m.createdAt,
    }));
  }
}
