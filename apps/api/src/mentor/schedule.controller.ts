import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { CurrentUser, Roles, type AuthenticatedUser } from '../auth/access';
import { ScheduleService } from './schedule.service';

@Controller('mentor')
@Roles('mentor')
export class ScheduleController {
  constructor(private readonly schedules: ScheduleService) {}

  @Get('availability')
  listWeekly(@CurrentUser() user: AuthenticatedUser) {
    return this.schedules.listWeekly(user.id);
  }

  @Post('availability')
  createWeekly(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    return this.schedules.saveWeekly(user, body);
  }

  @Patch('availability/:id')
  updateWeekly(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() body: unknown) {
    return this.schedules.saveWeekly(user, body, id);
  }

  @Delete('availability/:id')
  @HttpCode(204)
  deleteWeekly(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.schedules.remove(user, 'weekly_availability', id);
  }

  @Get('blockouts')
  listBlockout(@CurrentUser() user: AuthenticatedUser) {
    return this.schedules.listBlockouts(user.id);
  }

  @Post('blockouts')
  createBlockout(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    return this.schedules.saveBlockout(user, body);
  }

  @Patch('blockouts/:id')
  updateBlockout(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() body: unknown) {
    return this.schedules.saveBlockout(user, body, id);
  }

  @Delete('blockouts/:id')
  @HttpCode(204)
  deleteBlockout(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.schedules.remove(user, 'availability_blockouts', id);
  }
}
