import { Controller, Get, Post, Delete, Body, Param } from '@nestjs/common';
import { QueueService } from './queue.service.js';

@Controller('api/queue')
export class QueueController {
  constructor(private readonly queueService: QueueService) {}

  @Get()
  getQueue() {
    return {
      items: this.queueService.getQueueItems(),
      completed: this.queueService.getCompletedItems(),
      settings: this.queueService.getQueueSettings(),
    };
  }

  @Get('settings')
  getSettings() {
    return this.queueService.getQueueSettings();
  }

  @Post('settings')
  updateSettings(@Body() body: { key: string; value: string }) {
    this.queueService.updateQueueSetting(body.key, body.value);
    return { success: true };
  }

  @Post('add/:taskId')
  addToQueue(@Param('taskId') taskId: string) {
    return this.queueService.addToQueue(taskId);
  }

  @Delete(':taskId')
  removeFromQueue(@Param('taskId') taskId: string) {
    return this.queueService.removeFromQueue(taskId);
  }

  @Post('clear')
  clearCompleted() {
    const count = this.queueService.clearCompleted();
    return { success: true, cleared: count };
  }
}
