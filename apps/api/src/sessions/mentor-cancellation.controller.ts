import { Body, Controller, HttpCode, Param, Post } from '@nestjs/common';
import { CurrentUser, Roles, type AuthenticatedUser } from '../auth/access';
import { MentorCancellationService } from './mentor-cancellation.service';

// Mentor-only. The mentee endpoint POST /sessions/:id/cancel keeps its own 24-hour policy.
@Controller('mentor/sessions')
@Roles('mentor')
export class MentorCancellationController {
  constructor(private readonly cancellations: MentorCancellationService) {}

  @Post(':id/cancel')
  @HttpCode(200)
  cancel(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() body: unknown) {
    return this.cancellations.cancel(user, id, body);
  }
}
