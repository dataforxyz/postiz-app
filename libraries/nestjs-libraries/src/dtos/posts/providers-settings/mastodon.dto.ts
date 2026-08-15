import { IsIn, IsOptional } from 'class-validator';

export class MastodonDto {
  @IsIn(['public', 'unlisted', 'private'])
  @IsOptional()
  visibility?: 'public' | 'unlisted' | 'private';
}
