import { getAllowedIntegrationIds, hasTokenPermission } from './token-scopes';

describe('token scope helpers', () => {
  describe('getAllowedIntegrationIds', () => {
    it('returns undefined for legacy requests without token scopes', () => {
      expect(getAllowedIntegrationIds({} as any)).toBeUndefined();
      expect(
        getAllowedIntegrationIds({ tokenScopes: null } as any)
      ).toBeUndefined();
    });

    it('returns undefined when a scoped token is not integration-limited', () => {
      expect(
        getAllowedIntegrationIds({
          tokenScopes: { permissions: ['read'], integrationIds: null },
        } as any)
      ).toBeUndefined();
    });

    it('returns the allowed integration id list when present', () => {
      const integrationIds = ['integration-a', 'integration-b'];

      expect(
        getAllowedIntegrationIds({
          tokenScopes: { permissions: ['read'], integrationIds },
        } as any)
      ).toBe(integrationIds);
    });
  });

  describe('hasTokenPermission', () => {
    it('allows legacy tokens with no scoped permission payload', () => {
      expect(hasTokenPermission(null, 'write')).toBe(true);
      expect(hasTokenPermission(null, 'read')).toBe(true);
    });

    it('allows explicitly listed permissions', () => {
      expect(
        hasTokenPermission(
          { permissions: ['read', 'write'], integrationIds: ['integration-a'] },
          'write'
        )
      ).toBe(true);
    });

    it('rejects permissions missing from scoped tokens', () => {
      expect(
        hasTokenPermission(
          { permissions: ['read'], integrationIds: ['integration-a'] },
          'write'
        )
      ).toBe(false);
    });
  });
});
