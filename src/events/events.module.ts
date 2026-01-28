import { Module } from '@nestjs/common';
import { EventsController } from './events.controller.js';
import { EventService } from './event.service.js';

@Module({
  controllers: [EventsController],
  providers: [EventService],
  exports: [EventService],
})
export class EventsModule {}
