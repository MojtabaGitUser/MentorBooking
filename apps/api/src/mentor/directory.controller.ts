import { Controller, Get, Param, Query } from '@nestjs/common';
import { Roles } from '../auth/access';
import { DirectoryService } from './directory.service';

// The directory is for mentees choosing a mentor (API contract: GET /mentors, GET /mentors/:id).
@Controller('mentors')
@Roles('mentee')
export class DirectoryController {
  constructor(private readonly directory: DirectoryService) {}

  @Get()
  list(@Query() query: Record<string, unknown>) {
    return this.directory.list(query);
  }

  @Get(':id')
  profile(@Param('id') id: string) {
    return this.directory.profile(id);
  }
}
