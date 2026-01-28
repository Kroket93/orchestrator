import { Module } from '@nestjs/common';
import { AgentsController } from './agents.controller.js';
import { AgentManagerService } from './agent-manager.service.js';

@Module({
  controllers: [AgentsController],
  providers: [AgentManagerService],
  exports: [AgentManagerService],
})
export class AgentsModule {}
