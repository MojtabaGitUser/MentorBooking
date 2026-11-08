import { Controller, Get, Param, Query } from '@nestjs/common';
import { CurrentUser, Roles, type AuthenticatedUser } from '../auth/access';
import { SlotsService } from './slots.service';

@Controller('mentors')
@Roles('mentee')
export class SlotsController {
  constructor(private readonly slots: SlotsService) {}

  @Get(':mentorId/slots')
  list(@Param('mentorId') mentorId: string, @Query() query: Record<string, unknown>, @CurrentUser() user: AuthenticatedUser) {
    return this.slots.list(mentorId, query, user.timezone);
  }
}
