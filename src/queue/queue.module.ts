import { Module } from '@nestjs/common';
import { QueueController } from './queue.controller.js';
import { QueueService } from './queue.service.js';

@Module({
  controllers: [QueueController],
  providers: [QueueService],
  exports: [QueueService],
})
export class QueueModule {}
