import { Controller, Get, Post, Param, Body, Res, HttpStatus } from '@nestjs/common';
import { Response } from 'express';
import { AgentManagerService } from './agent-manager.service.js';
import { AgentConfig } from '../types/index.js';

@Controller('api/agents')
export class AgentsController {
  constructor(private readonly agentManager: AgentManagerService) {}

  @Get()
  async getAgents() {
    return this.agentManager.getAllAgents();
  }

  @Get('active')
  getActiveAgents() {
    return this.agentManager.getActiveAgents();
  }

  @Get('analytics')
  async getAnalytics() {
    return this.agentManager.getAnalytics();
  }

  @Get(':id')
  async getAgent(@Param('id') id: string) {
    return this.agentManager.getAgent(id);
  }

  @Get(':id/logs')
  async getAgentLogs(
    @Param('id') id: string,
    @Res() res: Response,
  ) {
    // Check if client wants SSE
    const acceptHeader = res.req.headers.accept || '';
    if (acceptHeader.includes('text/event-stream')) {
      // Set up SSE
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      // Send existing logs
      const logs = await this.agentManager.getAgentLogs(id);
      res.write(`data: ${JSON.stringify({ type: 'logs', content: logs })}\n\n`);

      // For now, just end the connection
      // TODO: Implement real-time log streaming
      res.end();
    } else {
      // Return logs as JSON object
      const logs = await this.agentManager.getAgentLogs(id);
      res.status(HttpStatus.OK).json({ logs });
    }
  }

  @Post('spawn')
  async spawnAgent(@Body() config: AgentConfig) {
    return this.agentManager.spawnAgent(config);
  }

  @Post(':id/kill')
  async killAgent(@Param('id') id: string) {
    await this.agentManager.killAgent(id);
    return { success: true };
  }

  @Post(':id/retry')
  async retryAgent(@Param('id') id: string) {
    const agent = await this.agentManager.retryAgent(id);
    return agent || { error: 'Could not retry agent' };
  }
}
