import { Controller, Get, Post, Body, Param } from '@nestjs/common';
import { EventService } from './event.service.js';
import { EventType } from '../types/index.js';

@Controller('api/events')
export class EventsController {
  constructor(private readonly eventService: EventService) {}

  @Get()
  getAllEvents() {
    return this.eventService.getAllEvents(50);
  }

  @Get('pending')
  getPendingEvents() {
    return this.eventService.getPendingEvents();
  }

  @Get('processed')
  getProcessedEvents() {
    return this.eventService.getProcessedEvents(50);
  }

  @Get(':id')
  getEvent(@Param('id') id: string) {
    return this.eventService.getPendingEvent(id);
  }

  @Post()
  createEvent(@Body() body: { type: EventType; payload: Record<string, unknown>; source: string }) {
    return this.eventService.createEvent(body.type, body.payload, body.source);
  }

  @Post(':id/processed')
  markProcessed(@Param('id') id: string) {
    const success = this.eventService.markProcessed(id);
    return { success };
  }
}
