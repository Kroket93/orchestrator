import { Module, forwardRef } from '@nestjs/common';
import { QueueController } from './queue.controller.js';
import { QueueService } from './queue.service.js';
import { QueueProcessorService } from './queue-processor.service.js';
import { AgentsModule } from '../agents/agents.module.js';
import { EventsModule } from '../events/events.module.js';

@Module({
  imports: [
    forwardRef(() => AgentsModule),
    forwardRef(() => EventsModule),
  ],
  controllers: [QueueController],
  providers: [QueueService, QueueProcessorService],
  exports: [QueueService, QueueProcessorService],
})
export class QueueModule {}
