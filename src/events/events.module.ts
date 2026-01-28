import { Module, forwardRef } from '@nestjs/common';
import { EventsController } from './events.controller.js';
import { EventService } from './event.service.js';
import { EventProcessorService } from './event-processor.service.js';
import { AgentsModule } from '../agents/agents.module.js';
import { QueueModule } from '../queue/queue.module.js';

@Module({
  imports: [
    forwardRef(() => AgentsModule),
    forwardRef(() => QueueModule),
  ],
  controllers: [EventsController],
  providers: [EventService, EventProcessorService],
  exports: [EventService, EventProcessorService],
})
export class EventsModule {}
