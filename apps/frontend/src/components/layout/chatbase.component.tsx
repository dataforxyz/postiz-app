'use client';

declare global {
  interface Window {
    chatbase: any;
  }
}

import { FC, useEffect } from 'react';
import { useVariables } from '@gitroom/react/helpers/variable.context';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { deleteDialog } from '@gitroom/react/helpers/delete.dialog';
import useSWR from 'swr';

export const ChatbaseComponent: FC = () => {
  const { isChatBase, chatbaseBotId } = useVariables();
  if (!isChatBase || !chatbaseBotId) {
    return null;
  }
  return <ChatbaseComponentLoad botId={chatbaseBotId} />;
};
export const ChatbaseComponentLoad: FC<{ botId: string }> = ({ botId }) => {
  const fetch = useFetch();

  const { data } = useSWR(
    'chatbase-token',
    async () => {
      return (await fetch('/user/chatbase-token')).json();
    },
    {
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      revalidateIfStale: false,
      refreshWhenHidden: false,
      refreshWhenOffline: false,
      refreshInterval: 0,
    }
  );

  if (!data) {
    return null;
  }

  return (
    <ChatBaseCode
      token={data.token}
      canManageBilling={data.canManageBilling}
      botId={botId}
    />
  );
};

const ChatBaseCode: FC<{
  token: string;
  canManageBilling: boolean;
  botId: string;
}> = ({
  token,
  canManageBilling,
  botId,
}) => {
  const fetch = useFetch();

  useEffect(() => {
    if (!window.chatbase || window.chatbase('getState') !== 'initialized') {
      // @ts-ignore
      window.chatbase = (...arg) => {
        if (!window.chatbase.q) {
          window.chatbase.q = [];
        }
        window.chatbase.q.push(arg);
      };
      window.chatbase = new Proxy(window.chatbase, {
        get(target, prop) {
          if (prop === 'q') {
            return target.q;
          }
          // @ts-ignore
          return (...args) => target(prop, ...args);
        },
      });
    }
    const onLoad = function () {
      const script = document.createElement('script');
      script.src = 'https://www.chatbase.co/embed.min.js';
      script.id = botId;
      // @ts-ignore
      script.domain = 'www.chatbase.co';
      document.body.appendChild(script);
    };
    if (document.readyState === 'complete') {
      onLoad();
    } else {
      window.addEventListener('load', onLoad);
    }

    window.chatbase('identify', { token });

    if (!canManageBilling) {
      return;
    }

    window.chatbase('registerTools', {
      stripe_refund: async () => {
        try {
          const previewResponse = await fetch(
            '/billing/chatbase-refund/preview'
          );

          if (!previewResponse.ok) {
            return {
              status: 'error',
              error: 'Could not process the refund request',
            };
          }

          const preview = await previewResponse.json();

          if (!preview.eligible) {
            return {
              status: 'success',
              data: { refunded: false, reason: preview.reason },
            };
          }

          const approved = await deleteDialog(
            `You are cancelling your ${
              preview.tier || ''
            } subscription and will receive a refund of ${preview.amount} ${(
              preview.currency || ''
            ).toUpperCase()}. Do you approve?`,
            'Yes, cancel and refund',
            'Cancel subscription'
          );

          if (!approved) {
            return {
              status: 'success',
              data: {
                refunded: false,
                reason: 'The user declined the refund confirmation',
              },
            };
          }

          const response = await fetch('/billing/chatbase-refund', {
            method: 'POST',
          });

          if (!response.ok) {
            return {
              status: 'error',
              error: 'Could not process the refund request',
            };
          }

          return {
            status: 'success',
            data: await response.json(),
          };
        } catch (err) {
          return {
            status: 'error',
            error: 'Could not process the refund request',
          };
        }
      },
    });
  }, [botId, canManageBilling, fetch, token]);
  return null;
};
