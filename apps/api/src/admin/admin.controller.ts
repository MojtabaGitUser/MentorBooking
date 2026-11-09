import { Body, Controller, Get, Param, Post, Query, Res } from '@nestjs/common';
import { CurrentUser, Roles, type AuthenticatedUser } from '../auth/access';
import { AdminService } from './admin.service';

@Controller('admin/users')
@Roles('admin')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get()
  users(@Query('q') query?: string) {
    return this.admin.findUsers(query);
  }

  @Get(':id/ledger')
  ledger(@Param('id') id: string, @Query('cursor') cursor?: string, @Query('limit') limit?: string) {
    return this.admin.ledgerFor(id, cursor, limit);
  }

  // 201 with a receipt for a new adjustment; 200 with the same receipt for an identical retry.
  @Post(':id/credits/adjust')
  async adjust(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() body: unknown,
               @Res({ passthrough: true }) response: { status(code: number): unknown }) {
    const { replayed, receipt } = await this.admin.adjust(user, id, body);
    response.status(replayed ? 200 : 201);
    return receipt;
  }
}
