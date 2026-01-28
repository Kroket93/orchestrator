import { Module, forwardRef } from '@nestjs/common';
import { AgentsController } from './agents.controller.js';
import { AgentManagerService } from './agent-manager.service.js';
import { EventsModule } from '../events/events.module.js';

@Module({
  imports: [
    forwardRef(() => EventsModule),
  ],
  controllers: [AgentsController],
  providers: [AgentManagerService],
  exports: [AgentManagerService],
})
export class AgentsModule {}
