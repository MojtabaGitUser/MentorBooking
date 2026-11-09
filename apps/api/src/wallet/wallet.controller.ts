import { Controller, Get, Query } from '@nestjs/common';
import { CurrentUser, Roles, type AuthenticatedUser } from '../auth/access';
import { WalletService } from './wallet.service';

@Controller('wallet/me')
@Roles('mentee')
export class WalletController {
  constructor(private readonly wallets: WalletService) {}

  @Get()
  wallet(@CurrentUser() user: AuthenticatedUser, @Query('include') include?: string) {
    return this.wallets.getWallet(user.id, undefined, include === 'purchases');
  }

  @Get('transactions')
  transactions(@CurrentUser() user: AuthenticatedUser, @Query('cursor') cursor?: string, @Query('limit') limit?: string) {
    return this.wallets.transactions(user.id, cursor, limit);
  }
}
