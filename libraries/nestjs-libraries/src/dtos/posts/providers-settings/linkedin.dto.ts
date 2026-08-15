import { IsBoolean, IsIn, IsOptional, IsString } from 'class-validator';

export class LinkedinDto {
  @IsIn(['PUBLIC', 'CONNECTIONS'])
  @IsOptional()
  visibility?: 'PUBLIC' | 'CONNECTIONS';

  @IsBoolean()
  @IsOptional()
  post_as_images_carousel: boolean;

  @IsString()
  @IsOptional()
  carousel_name?: string;
}
