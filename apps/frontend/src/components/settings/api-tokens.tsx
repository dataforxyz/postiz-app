'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import copy from 'copy-to-clipboard';
import { Button } from '@gitroom/react/form/button';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { useDecisionModal, useModals } from '@gitroom/frontend/components/layout/new-modal';

type IntegrationItem = {
  id: string;
  name: string;
  identifier: string;
  picture?: string;
};

type ApiTokenItem = {
  id: string;
  name: string;
  permissions: string[];
  createdAt: string;
  lastUsedAt?: string | null;
  revokedAt?: string | null;
  scopes: IntegrationItem[];
  integrationIds: string[] | null;
};

const TokenRevealModal = ({
  token,
  close,
}: {
  token: string;
  close: () => void;
}) => {
  const toaster = useToaster();

  return (
    <div className="flex flex-col gap-[16px] text-textColor">
      <div className="text-[20px] font-semibold">Copy your token now</div>
      <div className="text-customColor18">
        This token is only shown once. Store it before closing this dialog.
      </div>
      <div className="rounded-[4px] border border-fifth bg-sixth p-[16px] break-all">
        {token}
      </div>
      <div className="flex gap-[12px]">
        <Button
          onClick={() => {
            copy(token);
            toaster.show('API token copied to clipboard', 'success');
          }}
        >
          Copy token
        </Button>
        <Button onClick={close}>Close</Button>
      </div>
    </div>
  );
};

export const ApiTokensComponent = () => {
  const fetch = useFetch();
  const toaster = useToaster();
  const decision = useDecisionModal();
  const modals = useModals();
  const [tokens, setTokens] = useState<ApiTokenItem[]>([]);
  const [integrations, setIntegrations] = useState<IntegrationItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [name, setName] = useState('');
  const [read, setRead] = useState(true);
  const [write, setWrite] = useState(false);
  const [allIntegrations, setAllIntegrations] = useState(true);
  const [selectedIntegrations, setSelectedIntegrations] = useState<string[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    const [tokenResponse, integrationResponse] = await Promise.all([
      fetch('/api/tokens'),
      fetch('/integrations/list'),
    ]);

    const tokenJson = await tokenResponse.json();
    const integrationJson = await integrationResponse.json();
    setTokens(tokenJson.tokens || []);
    setIntegrations(integrationJson.integrations || []);
    setLoading(false);
  }, [fetch]);

  useEffect(() => {
    load();
  }, [load]);

  const permissionList = useMemo(() => {
    return [
      read ? 'read' : null,
      write ? 'write' : null,
    ].filter(Boolean) as string[];
  }, [read, write]);

  const createToken = useCallback(async () => {
    if (!name.trim()) {
      toaster.show('Token name is required', 'warning');
      return;
    }

    if (!permissionList.length) {
      toaster.show('Select at least one permission', 'warning');
      return;
    }

    setSubmitting(true);
    const response = await fetch('/api/tokens', {
      method: 'POST',
      body: JSON.stringify({
        name,
        permissions: permissionList,
        integrationIds: allIntegrations ? null : selectedIntegrations,
        allIntegrations,
      }),
    });

    const json = await response.json();
    setSubmitting(false);

    if (!response.ok) {
      toaster.show(json.message || json.msg || 'Failed to create token', 'warning');
      return;
    }

    setName('');
    setRead(true);
    setWrite(false);
    setAllIntegrations(true);
    setSelectedIntegrations([]);
    await load();
    modals.openModal({
      title: 'New API token',
      children: (close) => <TokenRevealModal token={json.token} close={close} />,
    });
  }, [
    allIntegrations,
    fetch,
    load,
    modals,
    name,
    permissionList,
    selectedIntegrations,
    toaster,
  ]);

  const revokeToken = useCallback(
    async (id: string) => {
      const approved = await decision.open({
        title: 'Revoke token?',
        description: 'This token will stop working immediately.',
        approveLabel: 'Revoke',
        cancelLabel: 'Cancel',
      });

      if (!approved) {
        return;
      }

      const response = await fetch(`/api/tokens/${id}`, {
        method: 'DELETE',
      });

      if (!response.ok) {
        toaster.show('Failed to revoke token', 'warning');
        return;
      }

      toaster.show('Token revoked', 'success');
      await load();
    },
    [decision, fetch, load, toaster]
  );

  return (
    <div className="flex flex-col gap-[20px]">
      <div>
        <h3 className="text-[20px]">Scoped API Tokens</h3>
        <div className="mt-[4px] text-customColor18">
          Create read-only or write tokens scoped to specific connected integrations.
        </div>
      </div>

      <div className="rounded-[4px] border border-fifth bg-sixth p-[20px]">
        <div className="grid gap-[12px]">
          <input
            className="rounded-[4px] border border-fifth bg-newBgColor px-[12px] py-[10px] outline-none"
            placeholder="Token name"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <div className="flex flex-wrap gap-[16px]">
            <label className="flex items-center gap-[8px]">
              <input
                type="checkbox"
                checked={read}
                onChange={(event) => setRead(event.target.checked)}
              />
              Read
            </label>
            <label className="flex items-center gap-[8px]">
              <input
                type="checkbox"
                checked={write}
                onChange={(event) => setWrite(event.target.checked)}
              />
              Write
            </label>
            <label className="flex items-center gap-[8px]">
              <input
                type="checkbox"
                checked={allIntegrations}
                onChange={(event) => setAllIntegrations(event.target.checked)}
              />
              All integrations
            </label>
          </div>
          {!allIntegrations && (
            <div className="grid gap-[8px] rounded-[4px] border border-fifth p-[12px]">
              {integrations.map((integration) => (
                <label
                  key={integration.id}
                  className="flex items-center justify-between gap-[12px]"
                >
                  <span>
                    {integration.name} ({integration.identifier})
                  </span>
                  <input
                    type="checkbox"
                    checked={selectedIntegrations.includes(integration.id)}
                    onChange={(event) => {
                      setSelectedIntegrations((current) =>
                        event.target.checked
                          ? [...current, integration.id]
                          : current.filter((item) => item !== integration.id)
                      );
                    }}
                  />
                </label>
              ))}
            </div>
          )}
          <div>
            <Button onClick={createToken} disabled={submitting}>
              {submitting ? 'Creating...' : 'Create token'}
            </Button>
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-[12px]">
        {loading && <div className="text-customColor18">Loading tokens...</div>}
        {!loading && !tokens.length && (
          <div className="text-customColor18">No scoped API tokens created yet.</div>
        )}
        {tokens.map((token) => (
          <div
            key={token.id}
            className="flex flex-col gap-[10px] rounded-[4px] border border-fifth bg-sixth p-[16px]"
          >
            <div className="flex items-center justify-between gap-[12px]">
              <div>
                <div className="font-semibold">{token.name}</div>
                <div className="text-[14px] text-customColor18">
                  {token.permissions.join(', ')} • created{' '}
                  {new Date(token.createdAt).toLocaleString()}
                  {token.lastUsedAt
                    ? ` • last used ${new Date(token.lastUsedAt).toLocaleString()}`
                    : ''}
                </div>
              </div>
              <Button onClick={() => revokeToken(token.id)}>Revoke</Button>
            </div>
            <div className="text-[14px] text-customColor18">
              {token.scopes.length
                ? `Scoped to: ${token.scopes
                    .map((scope) => `${scope.name} (${scope.identifier})`)
                    .join(', ')}`
                : 'Scoped to: all integrations'}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
