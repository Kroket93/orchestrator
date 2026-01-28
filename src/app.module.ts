import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';

import { DatabaseModule } from './database/database.module.js';
import { LoggerModule } from './logger/logger.module.js';
import { PromptsModule } from './prompts/prompts.module.js';
import { GithubModule } from './github/github.module.js';
import { AgentsModule } from './agents/agents.module.js';
import { EventsModule } from './events/events.module.js';
import { QueueModule } from './queue/queue.module.js';

@Module({
  imports: [
    // Configuration
    ConfigModule.forRoot({
      isGlobal: true,
    }),

    // Scheduling for queue processor
    ScheduleModule.forRoot(),

    // Core modules
    DatabaseModule,
    LoggerModule,
    PromptsModule,
    GithubModule,

    // Feature modules
    AgentsModule,
    EventsModule,
    QueueModule,
  ],
})
export class AppModule {}
