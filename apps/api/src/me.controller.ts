import { Controller, Get } from '@nestjs/common';
import { CurrentUser, type AuthenticatedUser } from './auth/access';

@Controller()
export class MeController {
  @Get('me')
  me(@CurrentUser() user: AuthenticatedUser) {
    return user;
  }
}
