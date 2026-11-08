import { Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { CurrentUser, Roles, type AuthenticatedUser } from '../auth/access';
import { LifecycleService } from './lifecycle.service';
import { SessionListService } from './session-list.service';

@Controller('sessions')
export class SessionLifecycleController {
  constructor(private readonly lifecycle: LifecycleService, private readonly sessions: SessionListService) {}

  // The participant role comes from the authenticated user and the session row; the body is ignored.
  @Post(':id/join')
  @Roles('mentee', 'mentor')
  @HttpCode(200)
  join(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.lifecycle.join(user, id);
  }

  @Get('me')
  @Roles('mentee')
  mine(@CurrentUser() user: AuthenticatedUser, @Query('status') status?: string) {
    return this.sessions.list(user.id, 'mentee', status);
  }
}

@Controller('mentor/sessions')
@Roles('mentor')
export class MentorSessionListController {
  constructor(private readonly sessions: SessionListService) {}

  @Get()
  mine(@CurrentUser() user: AuthenticatedUser, @Query('status') status?: string) {
    return this.sessions.list(user.id, 'mentor', status);
  }
}
