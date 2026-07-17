import {
  ArrayMaxSize,
  IsArray,
  IsDefined,
  IsString,
  IsUrl,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { IsSafeWebhookUrl } from '@gitroom/nestjs-libraries/dtos/webhooks/webhook.url.validator';

export class WebhooksIntegrationDto {
  @IsString()
  @IsDefined()
  id: string;
}

export class WebhooksDto {
  @IsString()
  @IsDefined()
  name: string;

  @IsString()
  @IsUrl()
  @IsDefined()
  @IsSafeWebhookUrl({
    message:
      'Webhook URL must be a canonical public HTTPS URL and cannot point to internal network addresses',
  })
  url: string;

  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => WebhooksIntegrationDto)
  @IsDefined()
  integrations: WebhooksIntegrationDto[];
}

// Shared by non-customer-webhook URL import flows. The customer webhook test
// route intentionally accepts only WebhookTestDto below.
export class OnlyURL {
  @IsString()
  @IsUrl()
  @IsDefined()
  @IsSafeWebhookUrl({
    message:
      'URL must be a canonical public HTTPS URL and cannot point to internal network addresses',
  })
  url: string;
}

export class UpdateDto extends WebhooksDto {
  @IsString()
  @IsDefined()
  id: string;
}

export class WebhookTestDto {
  @IsString()
  @IsDefined()
  id: string;
}
