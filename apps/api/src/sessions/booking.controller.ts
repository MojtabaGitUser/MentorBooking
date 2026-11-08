import { Body, Controller, Headers, Post, Res } from '@nestjs/common';
import { CurrentUser, Roles, type AuthenticatedUser } from '../auth/access';
import { BookingService } from './booking.service';

@Controller('sessions')
@Roles('mentee')
export class BookingController {
  constructor(private readonly bookings: BookingService) {}

  // The mentee is always the authenticated user; the body never names a mentee.
  @Post()
  async book(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown,
             @Headers('idempotency-key') key: string | undefined, @Res({ passthrough: true }) response: { status(code: number): unknown }) {
    const { replayed, booking } = await this.bookings.book(user.id, body, key);
    response.status(replayed ? 200 : 201);
    return booking;
  }
}
