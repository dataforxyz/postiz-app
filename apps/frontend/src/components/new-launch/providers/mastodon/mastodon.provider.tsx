'use client';

import {
  PostComment,
  withProvider,
} from '@gitroom/frontend/components/new-launch/providers/high.order.provider';
import { useSettings } from '@gitroom/frontend/components/launches/helpers/use.values';
import { MastodonDto } from '@gitroom/nestjs-libraries/dtos/posts/providers-settings/mastodon.dto';
import { Select } from '@gitroom/react/form/select';
import { useT } from '@gitroom/react/translation/get.transation.service.client';

const MastodonSettings = () => {
  const t = useT();
  const { register } = useSettings();

  return (
    <Select
      label={t('label_who_can_see_this_post', 'Who can see this post?')}
      {...register('visibility', { value: 'public' })}
    >
      <option value="public">{t('public', 'Public')}</option>
      <option value="unlisted">{t('quiet_public', 'Quiet public')}</option>
      <option value="private">{t('followers_only', 'Followers only')}</option>
    </Select>
  );
};

export default withProvider<MastodonDto>({
  postComment: PostComment.POST,
  minimumCharacters: [],
  SettingsComponent: MastodonSettings,
  CustomPreviewComponent: undefined,
  dto: MastodonDto,
  maximumCharacters: 500,
});
