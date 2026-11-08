import { Body, Controller, Headers, HttpCode, Post } from '@nestjs/common';
import { CurrentUser, Public, Roles, type AuthenticatedUser } from '../auth/access';
import { PaymentsService } from './payments.service';
import { verifiedEvent, webhookSecret } from './webhook';

@Controller()
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Roles('mentee')
  @Post('payments/purchases')
  purchase(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    return this.payments.purchase(user.id, body);
  }

  @Public()
  @Post('webhooks/fake-payments')
  @HttpCode(200)
  receive(@Body() raw: unknown, @Headers('x-webhook-signature') signature?: string) {
    return this.payments.receive(verifiedEvent(raw, signature, webhookSecret()));
  }
}
