import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { CurrentUser, Roles, type AuthenticatedUser } from '../auth/access';
import { CancellationService } from './cancellation.service';

// Mentee-only endpoints. Mentor cancellation (US-13) has its own route and policy.
@Controller('sessions')
@Roles('mentee')
export class CancellationController {
  constructor(private readonly cancellations: CancellationService) {}

  @Get(':id/cancellation-preview')
  preview(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.cancellations.preview(user, id);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  cancel(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() body: unknown) {
    return this.cancellations.cancel(user, id, body);
  }
}
