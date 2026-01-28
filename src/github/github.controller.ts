import { Controller, Get, Post, Body, Param, Query } from '@nestjs/common';
import { GithubService, PushResult, CreatePrResult, MergePrResult, PullRequest } from './github.service.js';

interface PushDto {
  repo: string;
  agentId: string;
  branch: string;
}

interface CreatePrDto {
  repo: string;
  head: string;
  base: string;
  title: string;
  body: string;
}

interface MergePrDto {
  commitTitle?: string;
  mergeMethod?: 'merge' | 'squash' | 'rebase';
}

@Controller('api/github')
export class GithubController {
  constructor(private readonly githubService: GithubService) {}

  @Get('status')
  getStatus(): { configured: boolean; owner: string } {
    return {
      configured: this.githubService.isConfigured(),
      owner: this.githubService.getOwner(),
    };
  }

  @Get('repo/:repo')
  async getRepo(@Param('repo') repo: string) {
    const repoInfo = await this.githubService.getRepo(repo);
    if (!repoInfo) {
      return { success: false, message: 'Repository not found' };
    }
    return { success: true, repo: repoInfo };
  }

  @Get('repo/:repo/default-branch')
  async getDefaultBranch(@Param('repo') repo: string): Promise<{ branch: string }> {
    const branch = await this.githubService.getDefaultBranch(repo);
    return { branch };
  }

  @Get('clone-url/:repo')
  getCloneUrl(@Param('repo') repo: string): { url: string } {
    return { url: this.githubService.getCloneUrl(repo) };
  }

  @Post('push')
  async pushBranch(@Body() dto: PushDto): Promise<PushResult> {
    return this.githubService.pushBranch(dto.repo, dto.agentId, dto.branch);
  }

  @Post('pr')
  async createPullRequest(@Body() dto: CreatePrDto): Promise<CreatePrResult> {
    return this.githubService.createPullRequest(
      dto.repo,
      dto.head,
      dto.base,
      dto.title,
      dto.body,
    );
  }

  @Get('pr/:repo/:prNumber')
  async getPullRequest(
    @Param('repo') repo: string,
    @Param('prNumber') prNumber: string,
  ): Promise<{ success: boolean; pr?: PullRequest; message?: string }> {
    const pr = await this.githubService.getPullRequest(repo, parseInt(prNumber, 10));
    if (!pr) {
      return { success: false, message: 'Pull request not found' };
    }
    return { success: true, pr };
  }

  @Post('pr/:repo/:prNumber/merge')
  async mergePullRequest(
    @Param('repo') repo: string,
    @Param('prNumber') prNumber: string,
    @Body() dto: MergePrDto,
  ): Promise<MergePrResult> {
    return this.githubService.mergePullRequest(repo, parseInt(prNumber, 10), dto);
  }

  @Get('prs/:repo')
  async listPullRequests(
    @Param('repo') repo: string,
    @Query('state') state?: 'open' | 'closed' | 'all',
  ): Promise<PullRequest[]> {
    return this.githubService.listPullRequests(repo, state || 'open');
  }

  @Post('ensure-remote/:repo')
  async ensureRemote(@Param('repo') repo: string) {
    try {
      const result = await this.githubService.ensureRemote(repo);
      return { success: true, ...result };
    } catch (error) {
      return { success: false, message: (error as Error).message };
    }
  }
}
